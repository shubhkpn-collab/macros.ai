"""
OFFLINE CATALOG BUNDLE COMPILER.

Derives a versioned, shard-hashed offline bundle from the FROZEN generic and
branded catalogs. Two distinct artifact classes:

  SEARCH PROJECTION  — retrieval only, never nutrition authority
  AUTHORITY PACK     — the immutable facts required to reproduce an exact
                       NutritionSnapshot and ProductCard offline

A field is copied into the authority pack only if logging or the card needs it.
"""
import json, glob, os, hashlib, shutil, sys

BUNDLE_VERSION = 'offline-bundle@1.0.0'
REQUIRED_SCHEMA = 1
STAGE = '/tmp/offline-stage'
OUT = 'data/offline-bundle'

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''): h.update(blk)
    return h.hexdigest()

if os.path.exists(STAGE): shutil.rmtree(STAGE)
os.makedirs(STAGE + '/search'); os.makedirs(STAGE + '/authority')

shards = []
def write_shard(rel, rows):
    path = os.path.join(STAGE, rel)
    with open(path, 'w') as fh:
        for r in rows:
            fh.write(json.dumps(r, sort_keys=True, separators=(',', ':')) + '\n')
    shards.append({'file': rel, 'records': len(rows),
                   'bytes': os.path.getsize(path), 'sha256': sha256_file(path)})

# ---- GENERIC (frozen) ------------------------------------------------------
generic = json.load(open('data/usda-seed.json'))
g_search, g_auth = [], []
for s in generic:
    g_search.append({
        'productId': s['productId'], 'productVersionId': s['productId'] + '@v1',
        'displayName': s['displayName'], 'kind': 'generic',
        'preparationState': s['preparationState'],
        'aliases': s.get('aliases') or [],
        'hasBarcode': False, 'discontinued': False,
        'recommendable': s.get('recommendable', True),
    })
    g_auth.append({
        'productId': s['productId'], 'productVersionId': s['productId'] + '@v1',
        'displayName': s['displayName'], 'kind': 'generic',
        'preparationState': s['preparationState'],
        'per100g': s['per100g'],
        'servingGrams': None, 'householdServingText': None,
        'source': s['externalIdentity'], 'discontinued': False,
    })
write_shard('search/generic.ndjson', sorted(g_search, key=lambda r: r['productVersionId']))
write_shard('authority/generic.ndjson', sorted(g_auth, key=lambda r: r['productVersionId']))

# ---- BRANDED (frozen full release) -----------------------------------------
# EXCLUSION LEDGER — mutually exclusive, first matching reason wins, so the
# categories sum exactly to the current-product population.
ledger = {'totalCurrentProducts': 0, 'excludedDiscontinued': 0,
          'excludedConflicted': 0, 'excludedNeedsReview': 0, 'offlineEligible': 0}
heads = {}
for f in sorted(glob.glob('data/branded/products-*.ndjson')):
    for line in open(f):
        h = json.loads(line)
        ledger['totalCurrentProducts'] += 1
        # A product excluded here is INTENTIONALLY not offline-loggable — it is
        # not a cache failure and must never be described as one.
        if h['isDiscontinued']:
            ledger['excludedDiscontinued'] += 1; continue
        if h['identifierState'] == 'conflicted':
            ledger['excludedConflicted'] += 1; continue
        if h['identifierState'] == 'needs_review':
            ledger['excludedNeedsReview'] += 1; continue
        ledger['offlineEligible'] += 1
        heads[h['currentProductVersionId']] = h

# Bucketed by a hash of productVersionId so a lookup reads exactly ONE small
# shard. RAM, not disk, is the binding constraint on the appliance.
AUTH_BUCKETS = 256
def auth_bucket(vid):
    return hashlib.sha256(vid.encode()).hexdigest()[:2]
SHARD_ROWS = 40000
gtin_index, s_buf, a_buf, s_i = {}, [], [], 0
auth_buckets = {}
b_search_rows = b_auth_rows = 0

for f in sorted(glob.glob('data/branded/versions-*.ndjson')):
    for line in open(f):
        v = json.loads(line)
        h = heads.get(v['productVersionId'])
        if h is None: continue
        pid, vid = h['productId'], v['productVersionId']
        s_buf.append({
            'productId': pid, 'productVersionId': vid,
            'displayName': v['sourceDescription'], 'kind': 'branded',
            'preparationState': 'as_sold',
            **({'brandName': v['brandName']} if v.get('brandName') else {}),
            **({'subbrandName': v['subbrandName']} if v.get('subbrandName') else {}),
            **({'brandOwner': v['brandOwner']} if v.get('brandOwner') else {}),
            'hasBarcode': bool(h.get('gtin14')), 'discontinued': False, 'recommendable': True,
        })
        # AUTHORITY: exactly what a NutritionSnapshot and ProductCard require.
        a_buf.append({
            'productId': pid, 'productVersionId': vid,
            'displayName': v['sourceDescription'], 'kind': 'branded',
            'preparationState': 'as_sold',
            'per100g': v['per100g'],
            'servingGrams': v.get('servingGrams'),
            'householdServingText': v.get('householdServingText'),
            'labelFacts': v.get('labelFacts'),
            'brandName': v.get('brandName'), 'subbrandName': v.get('subbrandName'),
            'gtin14': h.get('gtin14'),
            'hasIngredients': bool(v.get('ingredientsText')),
            'source': {'provider': 'usda_fdc', 'dataset': 'Branded',
                       'sourceRecordId': v['sourceRecordId'],
                       'verificationStatus': 'source_backed'},
            'discontinued': False,
        })
        if h.get('gtin14'): gtin_index[h['gtin14']] = vid
        b_search_rows += 1; b_auth_rows += 1
        auth_buckets.setdefault(auth_bucket(vid), []).append(a_buf.pop())
        if len(s_buf) >= SHARD_ROWS:
            write_shard('search/branded-%04d.ndjson' % s_i, s_buf); s_buf = []; s_i += 1
if s_buf: write_shard('search/branded-%04d.ndjson' % s_i, s_buf)
for bk in sorted(auth_buckets):
    write_shard('authority/branded-%s.ndjson' % bk,
                sorted(auth_buckets[bk], key=lambda r: r['productVersionId']))

# A4: BUCKETED GTIN INDEX. A single 22.8 MB index costs ~383 ms to parse, which
# is a real delay between a barcode scan and a result. Bucketing by the last two
# digits of the GTIN means a scan parses one ~90 KB bucket instead.
os.makedirs(STAGE + '/gtin', exist_ok=True)
gtin_buckets = {}
for g, vid in gtin_index.items():
    gtin_buckets.setdefault(g[-2:], {})[g] = vid
for bk in sorted(gtin_buckets):
    rel = 'gtin/%s.json' % bk
    bp = os.path.join(STAGE, rel)
    json.dump(gtin_buckets[bk], open(bp, 'w'), sort_keys=True, separators=(',', ':'))
    shards.append({'file': rel, 'records': len(gtin_buckets[bk]),
                   'bytes': os.path.getsize(bp), 'sha256': sha256_file(bp)})

branded_manifest = json.load(open('data/branded/manifest.json'))
manifest = {
    'bundleVersion': BUNDLE_VERSION,
    'requiredSchemaVersion': REQUIRED_SCHEMA,
    'buildComplete': True,
    'generatedFromCatalogDigests': {
        'brandedSourceChecksum': branded_manifest['sourceChecksum'],
        'brandedRecords': branded_manifest['sourceRecordCount'],
        'genericFoods': len(generic),
    },
    'policyVersions': branded_manifest['policyVersions'],
    'counts': {
        'genericSearchRows': len(g_search), 'genericAuthorityRows': len(g_auth),
        'brandedSearchRows': b_search_rows, 'brandedAuthorityRows': b_auth_rows,
        'gtinEntries': len(gtin_index),
    },
    'authorityBuckets': AUTH_BUCKETS,
    'eligibility': ledger,
    'shards': sorted(shards, key=lambda s: s['file']),
    'totalBytes': sum(s['bytes'] for s in shards),
}
# A6: shard metrics per CLASS. Conflating authority and search shard sizes is
# how "one ~15 MB authority shard" got stated without measurement supporting it.
auth_sh = [s2 for s2 in shards if s2['file'].startswith('authority/')]
srch_sh = [s2 for s2 in shards if s2['file'].startswith('search/')]
gtin_sh = [s2 for s2 in shards if s2['file'].startswith('gtin/')]
gtin_bytes = sum(s2['bytes'] for s2 in gtin_sh)
manifest['shardMetrics'] = {
    'authorityShardCount': len(auth_sh),
    'authorityTotalBytes': sum(s2['bytes'] for s2 in auth_sh),
    'authorityAverageShardBytes': round(sum(s2['bytes'] for s2 in auth_sh) / max(len(auth_sh), 1)),
    'authorityLargestShardBytes': max((s2['bytes'] for s2 in auth_sh), default=0),
    'searchShardCount': len(srch_sh),
    'searchTotalBytes': sum(s2['bytes'] for s2 in srch_sh),
    'searchLargestShardBytes': max((s2['bytes'] for s2 in srch_sh), default=0),
    'gtinIndexBytes': gtin_bytes,
    'gtinBucketCount': len(gtin_sh),
    'gtinLargestBucketBytes': max((s2['bytes'] for s2 in gtin_sh), default=0),
    'gtinAverageBucketBytes': round(gtin_bytes / max(len(gtin_sh), 1)),
    'manifestBytes': 0,
}
_mp = os.path.join(STAGE, 'manifest.json')
json.dump(manifest, open(_mp, 'w'), indent=1, sort_keys=True)
manifest['shardMetrics']['manifestBytes'] = os.path.getsize(_mp)
json.dump(manifest, open(_mp, 'w'), indent=1, sort_keys=True)

# ATOMIC PROMOTION: the bundle only becomes visible once fully built.
if os.path.exists(OUT): shutil.rmtree(OUT)
shutil.move(STAGE, OUT)

mb = lambda n: round(n / 1048576, 1)
srch = sum(s['bytes'] for s in shards if s['file'].startswith('search/'))
auth = sum(s['bytes'] for s in shards if s['file'].startswith('authority/'))
print('generic', len(g_auth), '| branded', b_auth_rows, '| gtin', len(gtin_index))
print('search MB', mb(srch), '| authority MB', mb(auth),
      '| gtin MB', mb(gtin_bytes), '| TOTAL MB', mb(manifest['totalBytes']))
sm = manifest['shardMetrics']
print('ledger:', ledger)
print('authority shards', sm['authorityShardCount'],
      '| avg MB', mb(sm['authorityAverageShardBytes']),
      '| largest MB', mb(sm['authorityLargestShardBytes']))
print('search shards', sm['searchShardCount'], '| largest MB', mb(sm['searchLargestShardBytes']))
