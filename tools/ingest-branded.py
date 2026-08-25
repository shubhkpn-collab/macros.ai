"""
REAL BRANDED INGESTION v2 — authoritative identity, immutable versions.

Streams the branded archive in bounded memory and builds:
  - branded PRODUCT identity from authoritative evidence only
  - immutable ProductVersions keyed by FACTUAL FINGERPRINT (never ordinal)
  - a GTIN lifecycle classification that does not treat a corporate rename
    as a product change
  - verbatim label facts and ingredient text

Identity policy is versioned; see BRANDED_IDENTITY_VERSION.
"""
import json, subprocess, sys, hashlib, collections, os, time

ZIP = '/mnt/user-data/uploads/FoodData_Central_branded_food_json_2026-04-30_json.zip'
INNER = 'FoodData_Central_branded_food_json_2026-04-30.json'
WINDOW = int(sys.argv[1]) if len(sys.argv) > 1 else 0

BRANDED_IDENTITY_VERSION = 'branded-identity@2.0.0'
BRANDED_VERSION_POLICY = 'branded-version-fingerprint@1.0.0'
GTIN_LIFECYCLE_POLICY = 'branded-gtin-lifecycle@1.0.0'

VALID_LEN = {8, 12, 13, 14}

def check_digit(payload):
    total, weight = 0, 3
    for ch in reversed(payload):
        total += int(ch) * weight
        weight = 1 if weight == 3 else 3
    return (10 - (total % 10)) % 10

def normalize_gtin(raw):
    if raw is None: return (None, 'empty')
    v = str(raw).strip()
    if not v: return (None, 'empty')
    c = v.replace(' ', '').replace('-', '')
    if not c.isdigit(): return (None, 'non_digit')
    if len(c) not in VALID_LEN: return (None, 'unsupported_length')
    if check_digit(c[:-1]) != int(c[-1]): return (None, 'bad_check_digit')
    return (c.zfill(14), None)

NUTRIENT_MAP = {
    1008: ('energy_kcal','kcal'), 1003: ('protein','g'), 1005: ('carbohydrate','g'),
    1004: ('fat','g'), 1079: ('fiber','g'), 2000: ('total_sugars','g'),
    1235: ('added_sugars','g'), 1258: ('saturated_fat','g'), 1253: ('cholesterol','mg'),
    1093: ('sodium','mg'), 1092: ('potassium','mg'), 1087: ('calcium','mg'),
    1089: ('iron','mg'), 1090: ('magnesium','mg'), 1091: ('phosphorus','mg'),
    1095: ('zinc','mg'), 1162: ('vitamin_c','mg'), 1114: ('vitamin_d','ug'),
    1106: ('vitamin_a','ug'), 1165: ('thiamin','mg'), 1166: ('riboflavin','mg'),
    1167: ('niacin','mg'), 1175: ('vitamin_b6','mg'), 1177: ('folate','ug'),
    1178: ('vitamin_b12','ug'),
}
UNMAPPED_REASONS = {1104:'Vitamin A IU',1110:'Vitamin D IU',1257:'Trans fat',
                    1292:'MUFA',1293:'PUFA',1062:'Energy kJ'}
CORE = ['energy_kcal','protein','carbohydrate','fat']

# Declared per-serving label facts, preserved verbatim and kept SEPARATE from
# normalized per-100 g values. Absent keys stay absent — never derived.
LABEL_KEYS = ['calories','protein','carbohydrates','fat','saturatedFat','transFat',
              'fiber','sugars','addedSugar','sodium','cholesterol','calcium','iron','potassium']

def records():
    proc = subprocess.Popen(['unzip','-p',ZIP,INNER], stdout=subprocess.PIPE, bufsize=1<<20)
    depth=0; buf=[]; ins=False; esc=False; started=False
    while True:
        chunk = proc.stdout.read(1<<20)
        if not chunk: break
        for ch in chunk.decode('utf-8','replace'):
            if not started:
                if ch=='[': started=True
                continue
            if ins:
                buf.append(ch)
                if esc: esc=False
                elif ch=='\\': esc=True
                elif ch=='"': ins=False
                continue
            if ch=='"': ins=True; buf.append(ch); continue
            if ch=='{': depth+=1
            if depth>0: buf.append(ch)
            if ch=='}':
                depth-=1
                if depth==0:
                    try: yield json.loads(''.join(buf))
                    except Exception: yield None
                    buf=[]
    proc.stdout.close(); proc.wait()

def parse_date(s):
    if not s: return None
    try:
        m,d,y = str(s).split('/'); return (int(y),int(m),int(d))
    except Exception: return None

def norm_brand(s):
    """Corporate suffixes are legal form, not product identity."""
    if not s: return ''
    t = str(s).lower()
    for junk in [' inc.',' inc',' llc',' l.l.c.',' co.',' company',' corp.',' corp',
                 ' ltd.',' ltd',' limited',' sales',' usa',' u.s.a.',' us',' plc',
                 ' gmbh',' s.a.',' holdings',' group',' brands',' foods',' the ']:
        t = t.replace(junk,' ')
    return ''.join(ch for ch in t if ch.isalnum())

STOP = {'the','and','with','of','a','an','in','for','oz','fl','ct','pack','count'}
def sem_tokens(desc):
    return {t for t in ''.join(c if c.isalnum() else ' ' for c in (desc or '').lower()).split()
            if t and t not in STOP and not t.isdigit()}

SPOOL = '/tmp/branded-spool.jsonl'

stats = collections.Counter()
gtin_reject = collections.Counter()
unmapped = collections.Counter()
serving_units = collections.Counter()
categories = collections.Counter()
# BOUNDED MEMORY: full records are spooled to disk and only a COMPACT index is
# held in RAM. Holding every record with its label facts and ingredient text
# exhausted 3 GB and the process was OOM-killed at ~275 s.
def brand_key(e):
    b = (e.get('brandName') or e.get('brandOwner') or '').lower()
    return ''.join(ch for ch in b if ch.isalnum())

spool = open(SPOOL, 'w')
by_gtin = collections.defaultdict(list)   # gtin14 -> [compact index entries]
no_gtin = []                              # [compact index entries]
update_edges = 0
t0 = time.time()

for r in records():
    stats['recordsRead'] += 1
    if r is None:
        stats['malformed'] += 1; continue
    if WINDOW and stats['recordsRead'] > WINDOW:
        stats['recordsRead'] -= 1; break

    desc = (r.get('description') or '').strip(); fdc = r.get('fdcId')
    if not desc or not fdc:
        stats['rejectedNoIdentity'] += 1; continue

    g14, reason = normalize_gtin(r.get('gtinUpc'))
    if g14 is None:
        gtin_reject[reason] += 1
        stats['missingGtin' if reason=='empty' else 'invalidGtin'] += 1
    else:
        stats['validGtin'] += 1

    per100 = {}
    for fn in (r.get('foodNutrients') or []):
        nu = (fn or {}).get('nutrient') or {}
        nid, amt = nu.get('id'), fn.get('amount')
        if nid is None or not isinstance(amt,(int,float)): continue
        if nid not in NUTRIENT_MAP:
            if nid not in UNMAPPED_REASONS: unmapped[nid] += 1
            continue
        canon, unit = NUTRIENT_MAP[nid]
        su = (nu.get('unitName') or unit).lower().replace('µg','ug').replace('mcg','ug')
        if su != unit: stats['unitMismatch'] += 1; continue
        if amt < 0: stats['negativeRejected'] += 1; continue
        per100[canon] = {'nutrientId':canon,'amount':amt,'unit':unit}

    if not all(c in per100 for c in CORE):
        stats['rejectedMissingCore'] += 1; continue

    unit = (r.get('servingSizeUnit') or '').lower(); size = r.get('servingSize')
    serving_units[unit or '(none)'] += 1
    serving_g = float(size) if unit=='g' and isinstance(size,(int,float)) and size>0 else None
    if serving_g is not None: stats['servingGramsAvailable'] += 1
    elif unit in ('ml','mlt'): stats['servingVolumeOnly'] += 1
    else: stats['servingUnavailable'] += 1

    # PART J: declared label facts, verbatim, separate from per100g.
    ln = r.get('labelNutrients') or {}
    declared = {}
    for k in LABEL_KEYS:
        v = ln.get(k)
        if isinstance(v,dict) and isinstance(v.get('value'),(int,float)):
            declared[k] = v['value']
    label_facts = {
        'servingSize': size if isinstance(size,(int,float)) else None,
        'servingSizeUnit': unit or None,
        'householdServingText': r.get('householdServingFullText') or None,
        'declared': declared,
    }

    if r.get('brandedFoodCategory'): categories[r['brandedFoodCategory']] += 1
    if r.get('ingredients'): stats['ingredientsPresent'] += 1
    if r.get('discontinuedDate'): stats['discontinued'] += 1

    prior = []
    for e in (r.get('foodUpdateLog') or []):
        eid = e.get('fdcId')
        if eid is not None and eid != fdc:
            prior.append(str(eid)); update_edges += 1

    entry = {
        'sourceRecordId': str(fdc),
        'sourceDescription': desc,
        'brandOwner': r.get('brandOwner') or None,
        'brandName': r.get('brandName') or None,
        'subbrandName': r.get('subbrandName') or None,
        'gtin14': g14,
        'gtinRaw': str(r['gtinUpc']) if r.get('gtinUpc') is not None else None,
        'gtinRejection': reason,
        'category': r.get('brandedFoodCategory') or None,
        'marketCountry': r.get('marketCountry') or None,
        'dataSource': r.get('dataSource') or None,
        'tradeChannels': r.get('tradeChannels') or None,
        'packageWeight': r.get('packageWeight') or None,
        'servingGrams': serving_g,
        'servingUnit': unit or None,
        'householdServingText': r.get('householdServingFullText') or None,
        'labelFacts': label_facts,
        # PART K: verbatim source text, never parsed into any claim.
        'ingredientsText': r.get('ingredients') or None,
        'discontinuedDate': r.get('discontinuedDate') or None,
        'modifiedDate': r.get('modifiedDate') or None,
        'availableDate': r.get('availableDate') or None,
        'publicationDate': r.get('publicationDate') or None,
        'priorSourceRecordIds': sorted(set(prior)),
        'per100g': per100,
        '_order': (parse_date(r.get('modifiedDate')) or parse_date(r.get('publicationDate')) or (0,0,0), str(fdc)),
    }
    off = spool.tell()
    spool.write(json.dumps(entry, sort_keys=True))
    spool.write('\n')
    compact = {
        '_off': off,
        'sourceRecordId': entry['sourceRecordId'],
        '_order': entry['_order'],
        '_brand': brand_key(entry),
        'priorSourceRecordIds': entry.get('priorSourceRecordIds') or [],
        'sourceDescription': entry['sourceDescription'][:80],
        'category': entry.get('category'),
        # Fields the lifecycle classifier needs BEFORE rehydration.
        'brandOwner': entry.get('brandOwner'),
        'brandName': entry.get('brandName'),
        'subbrandName': entry.get('subbrandName'),
        'discontinuedDate': entry.get('discontinuedDate'),
        'gtin14': entry.get('gtin14'),
    }
    (by_gtin[g14] if g14 else no_gtin).append(compact)

read_secs = time.time() - t0
spool.close()
_spool_read = open(SPOOL, 'r')

def hydrate(compact):
    """Read one full record back from the spool by byte offset."""
    _spool_read.seek(compact['_off'])
    return json.loads(_spool_read.readline())

stats['distinctGtin'] = len(by_gtin)
stats['duplicateGtinGroups'] = sum(1 for v in by_gtin.values() if len(v) > 1)
stats['updateLogEdges'] = update_edges

# ---------------------------------------------------------------------------
# PART I: FACTUAL FINGERPRINT. Ordinal numbering is deliberately NOT identity —
# importing an older record must never renumber an unchanged current version.
FACTUAL_FIELDS = ['sourceDescription','brandName','subbrandName','category',
                  'servingGrams','servingUnit','householdServingText',
                  'ingredientsText','packageWeight']
PROVENANCE_ONLY = ['sourceRecordId','dataSource','marketCountry','tradeChannels',
                   'publicationDate','availableDate','modifiedDate','priorSourceRecordIds']
LIFECYCLE_FIELDS = ['discontinuedDate','gtin14']

def fingerprint(e):
    payload = {k: e.get(k) for k in FACTUAL_FIELDS}
    payload['per100g'] = {k: e['per100g'][k]['amount'] for k in sorted(e['per100g'])}
    payload['declared'] = {k: e['labelFacts']['declared'][k] for k in sorted(e['labelFacts']['declared'])}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',',':')).encode()).hexdigest()

def compatible(a, b):
    """Deterministic product-semantic compatibility. No fuzzy merging."""
    ta, tb = sem_tokens(a['sourceDescription']), sem_tokens(b['sourceDescription'])
    if not ta or not tb: return False
    overlap = len(ta & tb) / min(len(ta), len(tb))
    cat_ok = (a['category'] is None or b['category'] is None or a['category'] == b['category'])
    return overlap >= 0.5 and cat_ok

products = {}          # productId -> product record
lifecycle_report = collections.Counter()
conflict_groups = []
review_groups = []

def make_product(identity_key, group, gtin14, state):
    pid = 'bprod_' + hashlib.sha256(identity_key.encode()).hexdigest()[:16]
    # Rehydrate ONLY this group's full records from the spool.
    group = [hydrate(c) if '_off' in c else c for c in sorted(group, key=lambda e: e['_order'])]
    versions = []
    seen_fp = {}
    for e in group:
        fp = fingerprint(e)
        if fp in seen_fp:
            # Identical facts republished: same version, provenance appended.
            seen_fp[fp]['sourceRecordIds'].append(e['sourceRecordId'])
            continue
        v = {k: e[k] for k in e if k != '_order'}
        v['productVersionId'] = pid + '@f' + fp[:16]
        v['factualFingerprint'] = fp
        v['sourceRecordIds'] = [e['sourceRecordId']]
        versions.append(v); seen_fp[fp] = v
    current = versions[-1]
    return {
        'productId': pid,
        'identityKey': identity_key,
        'identityBasis': ('validated_gtin' if gtin14 else 'isolated_source_record'),
        'gtin14': gtin14,
        'identifierState': state,
        'currentProductVersionId': current['productVersionId'],
        'isDiscontinued': bool(current.get('discontinuedDate')),
        # PART H: every historical version is retained, not just source ids.
        'versions': versions,
    }

for g14, group in sorted(by_gtin.items()):
    group.sort(key=lambda e: e['_order'])
    if len(group) == 1:
        lifecycle_report['single_record'] += 1
        p = make_product('gtin:' + g14, group, g14, 'current')
        products[p['productId']] = p
        continue

    # PART D/E: evidence order — update-log linkage, then semantics; a brand
    # rename ALONE never proves reassignment.
    ids = {e['sourceRecordId'] for e in group}
    linked = any(set(e['priorSourceRecordIds']) & ids for e in group)
    sem_ok = all(compatible(group[0], e) for e in group[1:])
    brands = {norm_brand(e['brandOwner'] or e['brandName']) for e in group if norm_brand(e['brandOwner'] or e['brandName'])}

    if linked and sem_ok:
        verdict = 'confirmed_update'
    elif sem_ok:
        verdict = 'confirmed_update' if len(brands) <= 1 else 'probable_update_needs_review'
    elif linked:
        verdict = 'probable_update_needs_review'
    else:
        verdict = 'identifier_reassignment_conflict'
    lifecycle_report[verdict] += 1

    detail = {'gtin14': g14, 'verdict': verdict,
              'sourceRecordIds': [e['sourceRecordId'] for e in group],
              'descriptions': [e['sourceDescription'][:70] for e in group],
              'brands': sorted(brands), 'updateLogLinked': linked,
              'semanticallyCompatible': sem_ok}

    if verdict == 'identifier_reassignment_conflict':
        conflict_groups.append(detail)
        # Reassignment: each era is its OWN product; the new product must never
        # inherit the old product's identity. Barcode lookup fails closed.
        for e in group:
            p = make_product('gtin-era:' + g14 + ':src:' + e['sourceRecordId'], [e], g14, 'conflicted')
            products[p['productId']] = p
        continue
    if verdict == 'probable_update_needs_review':
        review_groups.append(detail)
        for e in group:
            p = make_product('gtin-review:' + g14 + ':src:' + e['sourceRecordId'], [e], g14, 'needs_review')
            products[p['productId']] = p
        continue

    p = make_product('gtin:' + g14, group, g14, 'current')
    products[p['productId']] = p

# PART B: no GTIN and no authoritative linkage → each record is its OWN product.
# Brand + description matching is NOT sufficient evidence of sameness: TOPS
# "1% LOWFAT MILK" 2106478 and 2106480 differ by 42 vs 58 kcal.
by_src = {e['sourceRecordId']: e for e in no_gtin}
consumed = set()
for e in no_gtin:
    if e['sourceRecordId'] in consumed: continue
    chain = [e]
    for pid_ref in e['priorSourceRecordIds']:
        prev = by_src.get(pid_ref)
        if prev is not None and prev['sourceRecordId'] not in consumed:
            chain.append(prev); consumed.add(prev['sourceRecordId'])
    consumed.add(e['sourceRecordId'])
    root = min(x['sourceRecordId'] for x in chain)
    if len(chain) > 1: lifecycle_report['no_gtin_update_chain'] += 1
    else: lifecycle_report['no_gtin_isolated'] += 1
    p = make_product('src-chain:' + root, chain, None, None)
    products[p['productId']] = p

# PART C: the collision invariant, enforced on real output.
id_key = {}; ver_fp = {}
for p in products.values():
    if id_key.setdefault(p['productId'], p['identityKey']) != p['identityKey']:
        raise SystemExit('BLOCKER: productId maps to two identity keys: ' + p['productId'])
    for v in p['versions']:
        prev = ver_fp.setdefault(v['productVersionId'], v['factualFingerprint'])
        if prev != v['factualFingerprint']:
            raise SystemExit('BLOCKER: productVersionId maps to two fingerprints: ' + v['productVersionId'])

catalog = sorted(products.values(), key=lambda p: p['productId'])
total_versions = sum(len(p['versions']) for p in catalog)

with open(ZIP,'rb') as fh:
    h = hashlib.sha256()
    for blk in iter(lambda: fh.read(1<<22), b''): h.update(blk)

def cov(name):
    known = sum(1 for p in catalog
                if name in next(v for v in p['versions'] if v['productVersionId']==p['currentProductVersionId'])['per100g'])
    return {'nutrientId':name,'known':known,'total':len(catalog),
            'percent': round(known/len(catalog)*1000)/10 if catalog else 0}

report = {
  'identityVersion': BRANDED_IDENTITY_VERSION,
  'versionPolicy': BRANDED_VERSION_POLICY,
  'gtinLifecyclePolicy': GTIN_LIFECYCLE_POLICY,
  'fieldClassification': {'factual':FACTUAL_FIELDS,'provenanceOnly':PROVENANCE_ONLY,'lifecycle':LIFECYCLE_FIELDS},
  'source': {'provider':'USDA FoodData Central','dataType':'Branded','release':'April 2026',
             'archiveSha256':h.hexdigest(),'archiveBytes':os.path.getsize(ZIP),
             'windowRecords': WINDOW or None,
             'ingestionStrategy':'streamed via unzip -p; extracted JSON never materialised'},
  'stats': dict(stats),
  'gtinRejections': dict(gtin_reject),
  'lifecycle': dict(lifecycle_report),
  'identifierConflicts': conflict_groups[:60],
  'identifierConflictCount': len(conflict_groups),
  'needsReviewGroups': review_groups[:60],
  'needsReviewCount': len(review_groups),
  'publishedProducts': len(catalog),
  'productVersions': total_versions,
  'noGtinProducts': sum(1 for p in catalog if p['gtin14'] is None),
  'servingUnits': dict(serving_units.most_common(6)),
  'topCategories': dict(categories.most_common(10)),
  'unmappedNutrientIds': dict(unmapped.most_common(15)),
  'coverage': [cov(n) for n in ['fiber','total_sugars','added_sugars','saturated_fat',
      'cholesterol','sodium','potassium','calcium','iron','vitamin_a','vitamin_c','vitamin_d']],
}
os.makedirs('data', exist_ok=True)
json.dump(report, open('data/branded-report.json','w'), indent=1, sort_keys=True)
json.dump(catalog, open('data/branded-catalog.json','w'), indent=1, sort_keys=True)
print('read %d records in %ds (%.0f rec/s)' % (stats['recordsRead'], read_secs, stats['recordsRead']/max(read_secs,1)))
print('products', len(catalog), '| versions', total_versions, '| no-GTIN products', report['noGtinProducts'])
print('lifecycle', dict(lifecycle_report))
print('conflicts', len(conflict_groups), '| needs review', len(review_groups), '| updateLog edges', update_edges)
