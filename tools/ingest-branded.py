import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repo_paths import source_file, docs_output_dir, architecture_doc
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
import json, subprocess, sys, hashlib, collections, os, time, sqlite3, shutil

ZIP = source_file('FoodData_Central_branded_food_json_2026-04-30_json.zip')
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

BUILD_DB = '/tmp/branded-build.sqlite'
OUT_DIR = 'data/branded'
STAGE_DIR = '/tmp/branded-stage'

# BOUNDED-MEMORY BUILD STORE.
#
# Earlier designs held every record, then every finished product, in RAM and
# were OOM-killed on the full release. SQLite is used purely as temporary build
# infrastructure: it sorts and groups on DISK, so peak memory is one group
# rather than the whole catalog. It is NOT application persistence and nothing
# at runtime depends on it.
if os.path.exists(BUILD_DB): os.remove(BUILD_DB)
db = sqlite3.connect(BUILD_DB)
db.execute('PRAGMA journal_mode=OFF')
db.execute('PRAGMA synchronous=OFF')
db.execute('CREATE TABLE rec (src TEXT PRIMARY KEY, gtin14 TEXT, okey TEXT, brand TEXT, body TEXT)')
db.execute('CREATE TABLE edge (child TEXT, parent TEXT)')
_pending = []
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
    _pending.append((
        entry['sourceRecordId'],
        g14,
        '%04d%02d%02d|%s' % (entry['_order'][0][0], entry['_order'][0][1],
                             entry['_order'][0][2], entry['sourceRecordId'])
        if isinstance(entry['_order'], tuple) and isinstance(entry['_order'][0], tuple)
        else str(entry['_order']),
        brand_key(entry),
        json.dumps(entry, sort_keys=True, separators=(',', ':')),
    ))
    if len(_pending) >= 5000:
        db.executemany('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?)', _pending)
        _pending.clear()
    for _pid in (entry.get('priorSourceRecordIds') or []):
        db.execute('INSERT INTO edge VALUES (?,?)', (entry['sourceRecordId'], str(_pid)))

if _pending:
    db.executemany('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?)', _pending)
    _pending.clear()
db.commit()
db.execute('CREATE INDEX ix_gtin ON rec(gtin14, okey)')
db.execute('CREATE INDEX ix_edge ON edge(child)')
db.commit()
read_secs = time.time() - t0

stats['distinctGtin'] = db.execute(
    'SELECT COUNT(*) FROM (SELECT gtin14 FROM rec WHERE gtin14 IS NOT NULL GROUP BY gtin14)').fetchone()[0]
stats['duplicateGtinGroups'] = db.execute(
    'SELECT COUNT(*) FROM (SELECT gtin14 FROM rec WHERE gtin14 IS NOT NULL GROUP BY gtin14 HAVING COUNT(*)>1)').fetchone()[0]
stats['updateLogEdges'] = update_edges
stats['resolvedUpdateEdges'] = db.execute(
    'SELECT COUNT(*) FROM edge e JOIN rec r ON r.src = e.parent').fetchone()[0]
stats['brokenUpdateEdges'] = db.execute(
    'SELECT COUNT(*) FROM edge e LEFT JOIN rec r ON r.src = e.parent WHERE r.src IS NULL').fetchone()[0]
stats['updateCycles'] = db.execute(
    'SELECT COUNT(*) FROM edge a JOIN edge b ON a.child = b.parent AND a.parent = b.child').fetchone()[0]

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

# ---------------------------------------------------------------------------
# STREAMING EMISSION. Groups are read from the disk-backed store in a
# deterministic order and each finished product is written straight out, so
# neither products nor versions ever accumulate in memory.
os.makedirs(STAGE_DIR, exist_ok=True)
for f in os.listdir(STAGE_DIR): os.remove(os.path.join(STAGE_DIR, f))

SHARD_SIZE = 25000
_shard_idx = {'products': 0, 'versions': 0}
_shard_count = {'products': 0, 'versions': 0}
_shard_fh = {'products': None, 'versions': None}
shard_manifest = []

def _open_shard(kind):
    name = '%s-%04d.ndjson' % (kind, _shard_idx[kind])
    _shard_fh[kind] = open(os.path.join(STAGE_DIR, name), 'w')
    return name

def emit(kind, obj):
    if _shard_fh[kind] is None or _shard_count[kind] >= SHARD_SIZE:
        if _shard_fh[kind] is not None:
            _close_shard(kind)
            _shard_idx[kind] += 1
        _open_shard(kind)
        _shard_count[kind] = 0
    _shard_fh[kind].write(json.dumps(obj, sort_keys=True, separators=(',', ':')))
    _shard_fh[kind].write('\n')
    _shard_count[kind] += 1

def _close_shard(kind):
    name = '%s-%04d.ndjson' % (kind, _shard_idx[kind])
    _shard_fh[kind].close()
    path = os.path.join(STAGE_DIR, name)
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''): h.update(blk)
    shard_manifest.append({'file': name, 'records': _shard_count[kind],
                           'bytes': os.path.getsize(path), 'sha256': h.hexdigest()})

version_fingerprints = {}
product_identity = {}
nutrient_cov = collections.Counter()
label_facts_versions = 0
ingredients_versions = 0
multi_version_products = 0
identity_violations = []
fingerprint_violations = []
current_gtin_index = {}
head_index_rows = 0

def publish(product):
    global head_index_rows, label_facts_versions, ingredients_versions, multi_version_products
    pid = product['productId']
    if pid in product_identity and product_identity[pid] != product['identityKey']:
        identity_violations.append(pid)
    product_identity[pid] = product['identityKey']
    for v in product['versions']:
        vid = v['productVersionId']
        if vid in version_fingerprints and version_fingerprints[vid] != v['factualFingerprint']:
            fingerprint_violations.append(vid)
        version_fingerprints[vid] = v['factualFingerprint']
        if v.get('labelFacts'): label_facts_versions += 1
        if v.get('ingredientsText'): ingredients_versions += 1
        emit('versions', v)
    head = {k: product[k] for k in
            ('productId', 'identityKey', 'identityBasis', 'gtin14', 'identifierState',
             'currentProductVersionId', 'isDiscontinued')}
    head['versionIds'] = [v['productVersionId'] for v in product['versions']]
    if len(product['versions']) > 1: multi_version_products += 1
    cur = next(v for v in product['versions']
               if v['productVersionId'] == product['currentProductVersionId'])
    for n in cur['per100g']: nutrient_cov[n] += 1
    emit('products', head)
    head_index_rows += 1
    if product['gtin14'] and product['identifierState'] == 'current' and not product['isDiscontinued']:
        current_gtin_index.setdefault(product['gtin14'], []).append(pid)

def rows_for(gtin14):
    cur = db.execute('SELECT body FROM rec WHERE gtin14 = ? ORDER BY okey, src', (gtin14,))
    return [json.loads(r[0]) for r in cur]

lifecycle_report = collections.Counter()
conflict_groups = []
review_groups = []

for (g14,) in db.execute(
        'SELECT gtin14 FROM rec WHERE gtin14 IS NOT NULL GROUP BY gtin14 ORDER BY gtin14'):
    group = rows_for(g14)
    if len(group) == 1:
        lifecycle_report['single_record'] += 1
        publish(make_product('gtin:' + g14, group, g14, 'current'))
        continue

    ids = {e['sourceRecordId'] for e in group}
    linked = any(set(e['priorSourceRecordIds']) & ids for e in group)
    sem_ok = all(compatible(group[0], e) for e in group[1:])
    brands = {norm_brand(e['brandOwner'] or e['brandName'])
              for e in group if norm_brand(e['brandOwner'] or e['brandName'])}

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
        if len(conflict_groups) < 200: conflict_groups.append(detail)
        for e in group:
            publish(make_product('gtin-era:' + g14 + ':src:' + e['sourceRecordId'], [e], g14, 'conflicted'))
        continue
    if verdict == 'probable_update_needs_review':
        if len(review_groups) < 200: review_groups.append(detail)
        for e in group:
            publish(make_product('gtin-review:' + g14 + ':src:' + e['sourceRecordId'], [e], g14, 'needs_review'))
        continue

    publish(make_product('gtin:' + g14, group, g14, 'current'))

# PART B: no GTIN and no authoritative linkage -> each record is its OWN product.
for (src,) in db.execute('SELECT src FROM rec WHERE gtin14 IS NULL ORDER BY okey, src'):
    e = json.loads(db.execute('SELECT body FROM rec WHERE src = ?', (src,)).fetchone()[0])
    lifecycle_report['no_gtin_isolated'] += 1
    publish(make_product('src:' + src, [e], None, None))

for kind in ('products', 'versions'):
    if _shard_fh[kind] is not None: _close_shard(kind)

stats['publishedProducts'] = head_index_rows
stats['productVersions'] = len(version_fingerprints)

# PART C: collision invariants were enforced during streaming (see publish()).
if identity_violations:
    raise SystemExit('BLOCKER: productId maps to two identity keys: %r' % identity_violations[:5])
if fingerprint_violations:
    raise SystemExit('BLOCKER: productVersionId maps to two fingerprints: %r' % fingerprint_violations[:5])

with open(ZIP, 'rb') as fh:
    h = hashlib.sha256()
    for blk in iter(lambda: fh.read(1 << 22), b''): h.update(blk)

coverage = [{'nutrientId': n, 'known': nutrient_cov[n], 'total': head_index_rows,
             'percent': round(nutrient_cov[n] / head_index_rows * 1000) / 10 if head_index_rows else 0}
            for n in ['fiber', 'total_sugars', 'added_sugars', 'saturated_fat', 'cholesterol',
                      'sodium', 'potassium', 'calcium', 'iron', 'vitamin_a', 'vitamin_c', 'vitamin_d']]

# GTIN index for runtime barcode lookup (current, non-discontinued only).
gtin_index = {g: pids[0] for g, pids in sorted(current_gtin_index.items()) if len(pids) == 1}
gtin_ambiguous = {g: sorted(pids) for g, pids in sorted(current_gtin_index.items()) if len(pids) > 1}
with open(os.path.join(STAGE_DIR, 'gtin-index.json'), 'w') as fh:
    json.dump(gtin_index, fh, sort_keys=True, separators=(',', ':'))
with open(os.path.join(STAGE_DIR, 'gtin-ambiguous.json'), 'w') as fh:
    json.dump(gtin_ambiguous, fh, sort_keys=True, separators=(',', ':'))

report = {
  'identityVersion': BRANDED_IDENTITY_VERSION,
  'versionPolicy': BRANDED_VERSION_POLICY,
  'gtinLifecyclePolicy': GTIN_LIFECYCLE_POLICY,
  'fieldClassification': {'factual': FACTUAL_FIELDS, 'provenanceOnly': PROVENANCE_ONLY,
                          'lifecycle': LIFECYCLE_FIELDS},
  'source': {'provider': 'USDA FoodData Central', 'dataType': 'Branded', 'release': 'April 2026',
             'archiveSha256': h.hexdigest(), 'archiveBytes': os.path.getsize(ZIP),
             'totalRecords': stats['recordsRead'],
             'fullRelease': (WINDOW == 0),
             'windowRecords': WINDOW or None,
             'ingestionStrategy': 'streamed via unzip -p into a temporary SQLite build store; '
                                  'products and versions emitted incrementally as NDJSON shards; '
                                  'extracted JSON never materialised'},
  'stats': dict(stats),
  'gtinRejections': dict(gtin_reject),
  'lifecycle': dict(lifecycle_report),
  'identifierConflicts': conflict_groups[:60],
  'identifierConflictCount': lifecycle_report['identifier_reassignment_conflict'],
  'needsReviewGroups': review_groups[:60],
  'needsReviewCount': lifecycle_report['probable_update_needs_review'],
  'publishedProducts': head_index_rows,
  'productVersions': len(version_fingerprints),
  'multiVersionProducts': multi_version_products,
  'noGtinProducts': lifecycle_report['no_gtin_isolated'],
  'identityViolations': len(identity_violations),
  'fingerprintViolations': len(fingerprint_violations),
  'labelFactsVersions': label_facts_versions,
  'ingredientsTextVersions': ingredients_versions,
  'servingUnits': dict(serving_units.most_common(6)),
  'topCategories': dict(categories.most_common(10)),
  'unmappedNutrientIds': dict(unmapped.most_common(15)),
  'coverage': coverage,
  'shards': sorted(shard_manifest, key=lambda s: s['file']),
  'gtinIndex': {'currentUnique': len(gtin_index), 'ambiguous': len(gtin_ambiguous)},
}

# PART 34/35: ATOMIC COMPLETION. Outputs are staged and only promoted once the
# whole build succeeds, so an interrupted or OOM-killed run can never leave a
# partial catalog looking authoritative.
if os.path.exists(OUT_DIR): shutil.rmtree(OUT_DIR)
shutil.move(STAGE_DIR, OUT_DIR)
manifest = {
    'buildComplete': True,
    'sourceChecksum': h.hexdigest(),
    'sourceRecordCount': stats['recordsRead'],
    'fullRelease': (WINDOW == 0),
    'policyVersions': {'identity': BRANDED_IDENTITY_VERSION, 'version': BRANDED_VERSION_POLICY,
                       'gtinLifecycle': GTIN_LIFECYCLE_POLICY},
    'shards': sorted(shard_manifest, key=lambda s: s['file']),
    'products': head_index_rows,
    'versions': len(version_fingerprints),
}
json.dump(manifest, open(os.path.join(OUT_DIR, 'manifest.json'), 'w'), indent=1, sort_keys=True)
os.makedirs('data', exist_ok=True)
# NOTE: this OVERWRITES data/branded-report.json, dropping any benchmark
# sections a later step added. tools/benchmark-branded.py must therefore run
# AFTER every import; running it before leaves the report incomplete.
json.dump(report, open('data/branded-report.json', 'w'), indent=1, sort_keys=True)
db.close()
if os.path.exists(BUILD_DB):
    stats['tempDbBytes'] = os.path.getsize(BUILD_DB)
    os.remove(BUILD_DB)

print('read %d records in %ds (%.0f rec/s)' % (stats['recordsRead'], read_secs,
                                               stats['recordsRead'] / max(read_secs, 1)))
print('products', head_index_rows, '| versions', len(version_fingerprints),
      '| multi-version', multi_version_products, '| no-GTIN', lifecycle_report['no_gtin_isolated'])
print('lifecycle', dict(lifecycle_report))
print('conflicts', lifecycle_report['identifier_reassignment_conflict'],
      '| needs review', lifecycle_report['probable_update_needs_review'],
      '| updateLog edges', update_edges)
print('invariants: identity', len(identity_violations), '| fingerprint', len(fingerprint_violations))
print('labelFacts versions', label_facts_versions, '| ingredientsText versions', ingredients_versions)
print('shards', len(shard_manifest), '| gtin index', len(gtin_index), '| ambiguous', len(gtin_ambiguous))
