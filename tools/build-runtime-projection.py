"""
Compact runtime projection: identity + retrieval text ONLY.

The tablet must never parse the full catalog, and the projection must never
carry nutrition — that would make it a second, unversioned source of truth.
"""
import json, glob, os, hashlib

OUT = 'data/runtime'
os.makedirs(OUT, exist_ok=True)

heads = {}
for f in sorted(glob.glob('data/branded/products-*.ndjson')):
    for line in open(f):
        p = json.loads(line)
        heads[p['currentProductVersionId']] = p

rows, gtin_index = [], {}
for f in sorted(glob.glob('data/branded/versions-*.ndjson')):
    for line in open(f):
        v = json.loads(line)
        p = heads.get(v['productVersionId'])
        if p is None:
            continue  # historical version: resolvable, but not in current search
        if p['isDiscontinued'] or p['identifierState'] in ('conflicted', 'needs_review'):
            continue
        rows.append({
            'productId': p['productId'],
            'productVersionId': v['productVersionId'],
            'displayName': v['sourceDescription'],
            'kind': 'branded',
            'preparationState': 'as_sold',
            **({'brandName': v['brandName']} if v.get('brandName') else {}),
            **({'subbrandName': v['subbrandName']} if v.get('subbrandName') else {}),
            **({'brandOwner': v['brandOwner']} if v.get('brandOwner') else {}),
            'hasBarcode': bool(p.get('gtin14')),
            'discontinued': False,
            'recommendable': True,
        })
        if p.get('gtin14'):
            gtin_index[p['gtin14']] = v['productVersionId']

rows.sort(key=lambda r: (r['displayName'].lower(), r['productId']))

# SHARDED BY FIRST TOKEN LETTER. A 128 MB projection still exceeds what a tablet
# should parse, so runtime loads only the shards a query touches. Sharding is
# deterministic and content-addressed in the manifest.
shard_dir = os.path.join(OUT, 'search')
if os.path.exists(shard_dir):
    for f in os.listdir(shard_dir): os.remove(os.path.join(shard_dir, f))
os.makedirs(shard_dir, exist_ok=True)

def shard_key(r):
    import re as _re
    toks = _re.findall(r'[a-z0-9]+', r['displayName'].lower())
    first = toks[0] if toks else 'zz'
    c = first[0]
    return c if c.isalpha() else '0'

buckets = {}
for r in rows:
    buckets.setdefault(shard_key(r), []).append(r)

shard_manifest = []
for k in sorted(buckets):
    name = 'search-%s.ndjson' % k
    path = os.path.join(shard_dir, name)
    with open(path, 'w') as fh:
        for r in buckets[k]:
            fh.write(json.dumps(r, sort_keys=True, separators=(',', ':')) + '\n')
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''): h.update(blk)
    shard_manifest.append({'shard': k, 'file': name, 'rows': len(buckets[k]),
                           'bytes': os.path.getsize(path), 'sha256': h.hexdigest()})

with open(os.path.join(OUT, 'branded-search-projection.ndjson'), 'w') as fh:
    for r in rows:
        fh.write(json.dumps(r, sort_keys=True, separators=(',', ':')) + '\n')
json.dump(gtin_index, open(os.path.join(OUT, 'branded-gtin-index.json'), 'w'),
          sort_keys=True, separators=(',', ':'))

def sz(p): return os.path.getsize(p)
manifest = {
    'projectionVersion': 'catalog-projection@1.0.0',
    'brandedSearchRows': len(rows),
    'brandedGtinEntries': len(gtin_index),
    'sizes': {
        'searchProjectionBytes': sz(os.path.join(OUT, 'branded-search-projection.ndjson')),
        'gtinIndexBytes': sz(os.path.join(OUT, 'branded-gtin-index.json')),
        'canonicalVersionsBytes': sum(sz(f) for f in glob.glob('data/branded/versions-*.ndjson')),
        'canonicalProductsBytes': sum(sz(f) for f in glob.glob('data/branded/products-*.ndjson')),
    },
    'searchShards': shard_manifest,
    'largestShardBytes': max((s2['bytes'] for s2 in shard_manifest), default=0),
}
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1, sort_keys=True)
print('search rows', len(rows), '| gtin entries', len(gtin_index))
print('shards', len(shard_manifest), '| largest shard MB', round(manifest['largestShardBytes']/1048576,1))
print('sizes MB:', {k: round(v / 1048576, 1) for k, v in manifest['sizes'].items()})
