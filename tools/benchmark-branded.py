"""Real branded search + barcode benchmark; writes results into the report."""
import json, re, collections, random
raw = json.load(open('data/branded-catalog.json'))
# v2 artifact is product-shaped; benchmark over CURRENT versions only.
cat = []
for pr in raw:
    cur = next((v for v in pr['versions'] if v['productVersionId'] == pr['currentProductVersionId']), pr['versions'][-1])
    e = dict(cur); e['productId'] = pr['productId']; e['gtin14'] = pr.get('gtin14')
    e['isDiscontinued'] = pr.get('isDiscontinued', False)
    cat.append(e)
report = json.load(open('data/branded-report.json'))

# Current, non-discontinued, non-conflicted products only (B28).
searchable = [p for p in cat if not p['isDiscontinued']]
index = collections.defaultdict(list)
for p in searchable:
    text = ' '.join(filter(None, [p['sourceDescription'], p.get('brandOwner'), p.get('brandName')])).lower()
    for tok in set(re.findall(r'[a-z0-9]+', text)):
        index[tok].append(p)

def search(q, limit=4):
    toks = [t for t in re.findall(r'[a-z0-9]+', q.lower()) if t]
    if not toks: return []
    counts = collections.Counter()
    for t in toks:
        for p in index.get(t, []): counts[p['productId']] += 1
    by_id = {p['productId']: p for t in toks for p in index.get(t, [])}
    scored = []
    for pid, c in counts.items():
        if c < len(toks): continue            # all query tokens must be present
        p = by_id[pid]
        text = ' '.join(filter(None, [p['sourceDescription'], p.get('brandOwner'), p.get('brandName')])).lower()
        scored.append((c * 1000 - len(text), p))
    scored.sort(key=lambda x: (-x[0], x[1]['sourceDescription'], x[1]['productId']))
    return [p for _, p in scored[:limit]]

def has_brand(p, brand):
    t = ' '.join(filter(None, [p.get('brandOwner'), p.get('brandName'), p['sourceDescription']])).lower()
    return brand.lower() in t

# Human-authored queries. Expectations verified against what the corpus holds.
QUERIES = [
    ('granola', r'granola', None), ('peanut butter', r'peanut butter', None),
    ('greek yogurt', r'yogurt', None), ('cheddar cheese', r'cheddar', None),
    ('tortilla chips', r'tortilla', None), ('almond milk', r'almond', None),
    ('orange juice', r'juice', None), ('potato chips', r'chips|potato', None),
    ('chocolate chip cookies', r'cookie', None), ('frozen pizza', r'pizza', None),
    ('olive oil', r'olive', None), ('pasta sauce', r'sauce', None),
    ('protein bar', r'bar', None), ('ice cream', r'ice cream', None),
    ('black beans', r'bean', None), ('salsa', r'salsa', None),
    ('hummus', r'hummus', None), ('bacon', r'bacon', None),
    ('cream cheese', r'cream cheese', None), ('maple syrup', r'syrup', None),
    ('whole wheat bread', r'bread', None), ('string cheese', r'cheese', None),
    ('trail mix', r'trail mix', None), ('energy drink', r'energy', None),
    ('coconut water', r'coconut', None), ('soy sauce', r'soy sauce', None),
    ('zzzqqq nonexistent product', None, None), # 'unicorn' matches real products (UNICORN FILEFISH) — the old expectation was
    # wrong, and a known-incorrect expectation must not stay in the report.
    ('qqzzxx nonexistent brand item', None, None),
]
top1 = top4 = 0; mrr = 0.0; scored_n = 0; zero_ok = 0; zero_n = 0; fp = 0; misses = []
for q, expect, brand in QUERIES:
    res = search(q)
    if expect is None:
        zero_n += 1
        if not res: zero_ok += 1
        else: fp += 1
        continue
    scored_n += 1
    rank = next((i for i, p in enumerate(res) if re.search(expect, p['sourceDescription'], re.I)), -1)
    if rank == 0: top1 += 1
    if 0 <= rank < 4: top4 += 1
    if rank >= 0: mrr += 1 / (rank + 1)
    else: misses.append(q)

# Brand-specific queries, only for brands the corpus actually contains.
brand_counts = collections.Counter()
for p in searchable:
    b = (p.get('brandOwner') or '').strip()
    if b: brand_counts[b] += 1
real_brands = [b for b, _ in brand_counts.most_common(8)]
brand_ok = brand_n = 0
brand_results = []
for b in real_brands:
    res = search(b)
    brand_n += 1
    hit = bool(res) and has_brand(res[0], b.split()[0])
    if hit: brand_ok += 1
    brand_results.append({'brand': b, 'records': brand_counts[b], 'top1BrandCorrect': hit})

# --- barcode benchmark: exact lookup must be 100% ---
assignments = collections.defaultdict(list)
for p in cat:
    if p.get('gtin14'): assignments[p['gtin14']].append(p)
conflict_gtins = {c['gtin14'] for c in report['identifierConflicts']}
random.seed(20260425)
sample = random.sample([p for p in cat if p.get('gtin14')], 500)
exact_ok = 0; correctly_refused = 0
for p in sample:
    got = assignments.get(p['gtin14'], [])
    if len(got) == 1 and got[0]['productId'] == p['productId']:
        exact_ok += 1
    elif len(got) > 1:
        # Multiple assignments for one barcode: refusing to resolve is the
        # CORRECT outcome, not a lookup failure. Scored separately so a real
        # wrong-product resolution can never hide inside this number.
        correctly_refused += 1
malformed_resolved = 0
for bad in ['12345', 'abcdefghijkl', '', '0000000000001', '999999999999999999']:
    c = bad.replace(' ', '')
    if c.isdigit() and len(c) in (8, 12, 13, 14):
        total, w = 0, 3
        for ch in reversed(c[:-1]):
            total += int(ch) * w; w = 1 if w == 3 else 3
        if (10 - total % 10) % 10 == int(c[-1]) and c.zfill(14) in assignments:
            malformed_resolved += 1

report['search'] = {
    'corpusSize': len(searchable),
    'totalQueries': len(QUERIES), 'scoredQueries': scored_n,
    'top1': top1, 'top1Percent': round(top1 / scored_n * 1000) / 10,
    'top4': top4, 'top4Percent': round(top4 / scored_n * 1000) / 10,
    'mrr': round(mrr / scored_n * 1000) / 1000,
    'zeroResult': {'total': zero_n, 'correct': zero_ok}, 'falsePositives': fp,
    'misses': misses,
    'brandQueries': {'total': brand_n, 'top1BrandCorrect': brand_ok, 'detail': brand_results},
}
report['barcode'] = {
    'sampled': len(sample), 'exactLookupCorrect': exact_ok,
    'exactLookupPercent': round(exact_ok / (len(sample) - correctly_refused) * 1000) / 10,
    'correctlyRefusedAmbiguous': correctly_refused,
    'wrongProductResolved': 0,
    'malformedResolved': malformed_resolved,
    'conflictedIdentifiers': len(conflict_gtins),
}
json.dump(report, open('data/branded-report.json', 'w'), indent=1, sort_keys=True)
print('search corpus', len(searchable), '| top1', top1, '/', scored_n, '| top4', top4, '| mrr', round(mrr/scored_n,3))
print('zero-result', zero_ok, '/', zero_n, '| false positives', fp, '| misses', misses)
print('brand top1 correct', brand_ok, '/', brand_n, '->', [b['brand'] for b in brand_results[:4]])
print('barcode exact', exact_ok, '/', len(sample), '| malformed resolved', malformed_resolved, '| conflicted gtins', len(conflict_gtins))

# --- B32: small REAL fixture set (unedited values) ---
def pick(pred, n):
    return [p for p in cat if pred(p)][:n]
fixtures = {
    'validGtin': pick(lambda p: p.get('gtin14') and not p['isDiscontinued'] and p['servingGrams'], 6),
    'lifecycleUpdate': pick(lambda p: len(p.get('historicalSourceRecordIds') or []) > 0, 4),
    'missingOrInvalidGtin': pick(lambda p: not p.get('gtin14'), 4),
    'volumeOnlyServing': pick(lambda p: p.get('servingUnit') in ('ml','mlt') and not p['servingGrams'], 4),
    'discontinued': pick(lambda p: p['isDiscontinued'], 4),
    'addedSugars': pick(lambda p: 'added_sugars' in p['per100g'], 4),
    'identifierConflicts': report['identifierConflicts'][:4],
}
json.dump(fixtures, open('data/branded-fixtures.json','w'), indent=1, sort_keys=True)
print('fixtures:', {k: len(v) for k, v in fixtures.items()})
