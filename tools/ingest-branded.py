"""
REAL BRANDED INGESTION — bounded memory, deterministic.

Streams the 3.3 GB archive (never materialised), normalises GTINs, groups
lifecycle records, and emits a deterministic catalog plus a machine report.
"""
import json, subprocess, sys, hashlib, collections, os

ZIP = '/mnt/user-data/uploads/FoodData_Central_branded_food_json_2026-04-30_json.zip'
INNER = 'FoodData_Central_branded_food_json_2026-04-30.json'
WINDOW = int(sys.argv[1]) if len(sys.argv) > 1 else 0

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

# Canonical nutrient mapping — SOURCE ids, verified present in this corpus.
NUTRIENT_MAP = {
    1008: ('energy_kcal', 'kcal'), 1003: ('protein', 'g'), 1005: ('carbohydrate', 'g'),
    1004: ('fat', 'g'), 1079: ('fiber', 'g'), 2000: ('total_sugars', 'g'),
    1235: ('added_sugars', 'g'), 1258: ('saturated_fat', 'g'), 1253: ('cholesterol', 'mg'),
    1093: ('sodium', 'mg'), 1092: ('potassium', 'mg'), 1087: ('calcium', 'mg'),
    1089: ('iron', 'mg'), 1090: ('magnesium', 'mg'), 1091: ('phosphorus', 'mg'),
    1095: ('zinc', 'mg'), 1162: ('vitamin_c', 'mg'), 1114: ('vitamin_d', 'ug'),
    1106: ('vitamin_a', 'ug'), 1165: ('thiamin', 'mg'), 1166: ('riboflavin', 'mg'),
    1167: ('niacin', 'mg'), 1175: ('vitamin_b6', 'mg'), 1177: ('folate', 'ug'),
    1178: ('vitamin_b12', 'ug'),
}
# Deliberately unmapped, with reasons (IU factors are substance-specific).
UNMAPPED_REASONS = {1104: 'Vitamin A IU', 1110: 'Vitamin D IU', 1257: 'Trans fat (no canonical id)',
                    1292: 'MUFA', 1293: 'PUFA', 1062: 'Energy kJ'}
CORE = ['energy_kcal', 'protein', 'carbohydrate', 'fat']

def records():
    proc = subprocess.Popen(['unzip', '-p', ZIP, INNER], stdout=subprocess.PIPE, bufsize=1 << 20)
    depth = 0; buf = []; in_str = False; esc = False; started = False
    while True:
        chunk = proc.stdout.read(1 << 20)
        if not chunk: break
        for ch in chunk.decode('utf-8', 'replace'):
            if not started:
                if ch == '[': started = True
                continue
            if in_str:
                buf.append(ch)
                if esc: esc = False
                elif ch == '\\': esc = True
                elif ch == '"': in_str = False
                continue
            if ch == '"': in_str = True; buf.append(ch); continue
            if ch == '{': depth += 1
            if depth > 0: buf.append(ch)
            if ch == '}':
                depth -= 1
                if depth == 0:
                    try: yield json.loads(''.join(buf))
                    except Exception: yield None
                    buf = []
    proc.stdout.close(); proc.wait()

stats = collections.Counter()
gtin_reject = collections.Counter()
unmapped = collections.Counter()
by_gtin = collections.defaultdict(list)   # gtin14 -> lifecycle records
no_gtin = []
serving_units = collections.Counter()
categories = collections.Counter()
nutrient_present = collections.Counter()

def parse_date(s):
    # USDA writes M/D/YYYY. Sortable tuple; None sorts last, never guessed.
    if not s: return None
    try:
        m, d, y = str(s).split('/')
        return (int(y), int(m), int(d))
    except Exception:
        return None

for r in records():
    stats['recordsRead'] += 1
    if r is None:
        stats['malformed'] += 1
        continue
    if WINDOW and stats['recordsRead'] > WINDOW:
        stats['recordsRead'] -= 1
        break

    desc = (r.get('description') or '').strip()
    fdc = r.get('fdcId')
    if not desc or not fdc:
        stats['rejectedNoIdentity'] += 1
        continue

    g14, reason = normalize_gtin(r.get('gtinUpc'))
    if g14 is None:
        gtin_reject[reason] += 1
        if reason == 'empty': stats['missingGtin'] += 1
        else: stats['invalidGtin'] += 1
    else:
        stats['validGtin'] += 1

    per100 = {}
    for fn in (r.get('foodNutrients') or []):
        nu = (fn or {}).get('nutrient') or {}
        nid, amt = nu.get('id'), fn.get('amount')
        if nid is None or not isinstance(amt, (int, float)): continue
        if nid not in NUTRIENT_MAP:
            if nid not in UNMAPPED_REASONS: unmapped[nid] += 1
            continue
        canon, unit = NUTRIENT_MAP[nid]
        src_unit = (nu.get('unitName') or unit).lower().replace('µg', 'ug').replace('mcg', 'ug')
        if src_unit != unit:      # unit disagreement is curation, never converted blindly
            stats['unitMismatch'] += 1
            continue
        if amt < 0:
            stats['negativeRejected'] += 1
            continue
        per100[canon] = {'nutrientId': canon, 'amount': amt, 'unit': unit}
        nutrient_present[canon] += 1

    if not all(c in per100 for c in CORE):
        stats['rejectedMissingCore'] += 1
        continue

    unit = (r.get('servingSizeUnit') or '').lower()
    size = r.get('servingSize')
    serving_units[unit or '(none)'] += 1
    serving_g = float(size) if unit == 'g' and isinstance(size, (int, float)) and size > 0 else None
    if serving_g is None and unit in ('ml', 'mlt'):
        stats['servingVolumeOnly'] += 1
    elif serving_g is not None:
        stats['servingGramsAvailable'] += 1
    else:
        stats['servingUnavailable'] += 1

    if r.get('brandedFoodCategory'): categories[r['brandedFoodCategory']] += 1
    if r.get('ingredients'): stats['ingredientsPresent'] += 1
    disc = r.get('discontinuedDate')
    if disc: stats['discontinued'] += 1

    entry = {
        'sourceRecordId': str(fdc),
        'sourceDescription': desc,
        'brandOwner': r.get('brandOwner') or None,
        'brandName': r.get('brandName') or None,
        'gtin14': g14,
        'gtinRaw': (str(r.get('gtinUpc')) if r.get('gtinUpc') is not None else None),
        'gtinRejection': reason,
        'category': r.get('brandedFoodCategory') or None,
        'marketCountry': r.get('marketCountry') or None,
        'dataSource': r.get('dataSource') or None,
        'servingGrams': serving_g,
        'servingUnit': unit or None,
        'servingSizeRaw': size,
        'householdServingText': r.get('householdServingFullText') or None,
        'ingredientsPresent': bool(r.get('ingredients')),
        'discontinuedDate': disc or None,
        'modifiedDate': r.get('modifiedDate') or None,
        'availableDate': r.get('availableDate') or None,
        'publicationDate': r.get('publicationDate') or None,
        'per100g': per100,
        'sortKey': (parse_date(r.get('modifiedDate')) or parse_date(r.get('publicationDate')) or (0, 0, 0), str(fdc)),
    }
    if g14: by_gtin[g14].append(entry)
    else: no_gtin.append(entry)

stats['distinctGtin'] = len(by_gtin)
stats['duplicateGtinGroups'] = sum(1 for v in by_gtin.values() if len(v) > 1)
stats['recordsInDuplicateGroups'] = sum(len(v) for v in by_gtin.values() if len(v) > 1)

def brand_key(e):
    b = (e['brandOwner'] or e['brandName'] or '').lower()
    return ''.join(ch for ch in b if ch.isalnum())

published, conflicts, versions = [], [], 0
for g14, group in sorted(by_gtin.items()):
    # Lifecycle order from real temporal fields — NEVER array order.
    group.sort(key=lambda e: e['sortKey'])
    brands = {brand_key(e) for e in group if brand_key(e)}
    if len(brands) > 1:
        # Same barcode, materially unrelated brands: never silently merged.
        conflicts.append({'gtin14': g14, 'brands': sorted(brands),
                          'sourceRecordIds': [e['sourceRecordId'] for e in group],
                          'descriptions': [e['sourceDescription'][:70] for e in group]})
        stats['identifierConflicts'] += 1
        continue
    versions += len(group)
    current = group[-1]                       # newest by real dates
    current = dict(current); current.pop('sortKey', None)
    current['gtin14'] = g14
    current['historicalSourceRecordIds'] = [e['sourceRecordId'] for e in group[:-1]]
    current['identifierState'] = 'current'
    current['isDiscontinued'] = bool(current.get('discontinuedDate'))
    pid = 'bprod_' + hashlib.sha256(('gtin:' + g14).encode()).hexdigest()[:16]
    current['productId'] = pid
    current['productVersionId'] = pid + '@v' + str(len(group))
    published.append(current)

for e in no_gtin:
    e = dict(e); e.pop('sortKey', None)
    key = 'name:' + (brand_key(e) + '|' + e['sourceDescription'].lower()).strip()
    pid = 'bprod_' + hashlib.sha256(key.encode()).hexdigest()[:16]
    e['productId'] = pid
    e['productVersionId'] = pid + '@v1'
    e['identifierState'] = None
    e['isDiscontinued'] = bool(e.get('discontinuedDate'))
    e['historicalSourceRecordIds'] = []
    published.append(e)
    versions += 1

published.sort(key=lambda e: (e['sourceDescription'].lower(), e['productId']))
seen_pid = {}
for e in published:
    if e['productId'] in seen_pid and seen_pid[e['productId']] != e['productVersionId']:
        raise SystemExit('BLOCKER: productId collision ' + e['productId'])
    seen_pid[e['productId']] = e['productVersionId']

with open('/mnt/user-data/uploads/FoodData_Central_branded_food_json_2026-04-30_json.zip', 'rb') as fh:
    h = hashlib.sha256()
    for blk in iter(lambda: fh.read(1 << 22), b''): h.update(blk)
archive_sha = h.hexdigest()

coverage = []
for canon in ['fiber','total_sugars','added_sugars','saturated_fat','cholesterol','sodium',
              'potassium','calcium','iron','magnesium','zinc','vitamin_a','vitamin_c',
              'vitamin_d','thiamin','riboflavin','niacin','vitamin_b6','folate','vitamin_b12']:
    known = sum(1 for e in published if canon in e['per100g'])
    coverage.append({'nutrientId': canon, 'known': known, 'total': len(published),
                     'percent': round(known / len(published) * 1000) / 10 if published else 0})

report = {
    'source': {'provider': 'USDA FoodData Central', 'dataType': 'Branded',
               'release': 'April 2026', 'archiveSha256': archive_sha,
               'archiveBytes': os.path.getsize(ZIP),
               'extractedBytesApprox': 3315545761,
               'ingestionStrategy': 'streamed via unzip -p, brace-depth record split, per-record JSON parse; extracted JSON never materialised',
               'windowRecords': WINDOW or None},
    'gtinPolicyVersion': 'gtin@1.0.0',
    'stats': dict(stats),
    'gtinRejections': dict(gtin_reject),
    'servingUnits': dict(serving_units.most_common(6)),
    'topCategories': dict(categories.most_common(10)),
    'unmappedNutrientIds': dict(unmapped.most_common(15)),
    'identifierConflicts': conflicts[:50],
    'identifierConflictCount': len(conflicts),
    'publishedProducts': len(published),
    'productVersions': versions,
    'coverage': coverage,
}
os.makedirs('data', exist_ok=True)
with open('data/branded-report.json', 'w') as fh: json.dump(report, fh, indent=1, sort_keys=True)
with open('data/branded-catalog.json', 'w') as fh: json.dump(published, fh, indent=1, sort_keys=True)
print('records', stats['recordsRead'], '| published', len(published), '| versions', versions)
print('gtin valid', stats['validGtin'], 'invalid', stats['invalidGtin'], 'missing', stats['missingGtin'])
print('rejections', dict(gtin_reject))
print('dup groups', stats['duplicateGtinGroups'], '| conflicts', len(conflicts))
print('missing core', stats['rejectedMissingCore'], '| serving g', stats['servingGramsAvailable'], '| ml-only', stats['servingVolumeOnly'])
print('discontinued', stats['discontinued'], '| ingredients', stats['ingredientsPresent'])
print('added_sugars coverage', [c for c in coverage if c['nutrientId']=='added_sugars'])
