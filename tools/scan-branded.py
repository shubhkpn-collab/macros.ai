import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repo_paths import source_file, docs_output_dir, architecture_doc
"""
BOUNDED-MEMORY SCAN of the USDA Branded archive.

The extracted JSON is 3.3 GB against 3 GB RAM and 10 GB free disk, so it is
never written to disk and never fully parsed. `unzip -p` streams it, records are
split by brace depth (respecting strings and escapes), and each record is parsed
individually by the real JSON parser. Peak memory stays at one record.
"""
import json, subprocess, sys, collections

ZIP = source_file('FoodData_Central_branded_food_json_2026-04-30_json.zip')
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0

def records():
    proc = subprocess.Popen(
        ['unzip', '-p', ZIP, 'FoodData_Central_branded_food_json_2026-04-30.json'],
        stdout=subprocess.PIPE, bufsize=1 << 20)
    depth = 0; buf = []; in_str = False; esc = False; started = False
    while True:
        chunk = proc.stdout.read(1 << 20)
        if not chunk:
            break
        for ch in chunk.decode('utf-8', 'replace'):
            if not started:
                if ch == '[':
                    started = True
                continue
            if in_str:
                buf.append(ch)
                if esc: esc = False
                elif ch == '\\': esc = True
                elif ch == '"': in_str = False
                continue
            if ch == '"':
                in_str = True; buf.append(ch); continue
            if ch == '{':
                depth += 1
            if depth > 0:
                buf.append(ch)
            if ch == '}':
                depth -= 1
                if depth == 0:
                    try:
                        yield json.loads(''.join(buf))
                    except Exception:
                        yield None
                    buf = []
    proc.stdout.close(); proc.wait()

n = 0
keys = collections.Counter()
gtin_len = collections.Counter()
gtin_nondigit = 0
missing_gtin = 0
serving_unit = collections.Counter()
categories = collections.Counter()
data_sources = collections.Counter()
has_field = collections.Counter()
nutrient_ids = collections.Counter()
gtin_seen = collections.Counter()
label_nutrient_keys = collections.Counter()
malformed = 0

for r in records():
    n += 1
    if r is None:
        malformed += 1
        continue
    for k in r.keys(): keys[k] += 1
    g = r.get('gtinUpc')
    if g is None or g == '':
        missing_gtin += 1
    else:
        g = str(g)
        if not g.isdigit(): gtin_nondigit += 1
        gtin_len[len(g)] += 1
        gtin_seen[g] += 1
    if r.get('servingSizeUnit'): serving_unit[str(r['servingSizeUnit']).lower()] += 1
    if r.get('brandedFoodCategory'): categories[r['brandedFoodCategory']] += 1
    if r.get('dataSource'): data_sources[str(r['dataSource'])] += 1
    for f in ['discontinuedDate','packageWeight','ingredients','labelNutrients','foodUpdateLog','brandName','subbrandName','tradeChannels','shortDescription','marketCountry']:
        if r.get(f): has_field[f] += 1
    for fn in (r.get('foodNutrients') or []):
        nu = (fn or {}).get('nutrient') or {}
        if nu.get('id'): nutrient_ids[nu['id']] += 1
    for k in (r.get('labelNutrients') or {}).keys(): label_nutrient_keys[k] += 1
    if LIMIT and n >= LIMIT: break

dup = sum(1 for v in gtin_seen.values() if v > 1)
dup_records = sum(v for v in gtin_seen.values() if v > 1)
print('records', n, '| malformed', malformed)
print('field presence:', dict(has_field.most_common()))
print('gtin lengths:', dict(gtin_len.most_common()))
print('gtin non-digit:', gtin_nondigit, '| missing:', missing_gtin)
print('distinct gtins:', len(gtin_seen), '| duplicated gtins:', dup, '| records in dup groups:', dup_records)
print('serving units:', dict(serving_unit.most_common(8)))
print('dataSource:', dict(data_sources.most_common(8)))
print('labelNutrients keys:', dict(label_nutrient_keys.most_common(20)))
print('top nutrient ids:', dict(nutrient_ids.most_common(22)))
print('top categories:', dict(categories.most_common(8)))
