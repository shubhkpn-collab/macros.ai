import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessCandidate,
  atwaterDeltaFraction,
  buildSearchProjection,
  canonicalFingerprint,
  isPublishable,
  KNOWN_SOURCES,
  type CatalogSourceDefinition,
  type CurationManifest,
} from '@macros/domain-catalog';
import {
  runImport,
  buildQualityReport,
  SyntheticSourceAdapter,
  SYNTHETIC_SOURCE_KEY,
  UsdaFdcAdapterPending,
  type CatalogState,
} from '@macros/catalog-ingestion';

const ROOT = new URL('..', import.meta.url).pathname;
const curation = JSON.parse(
  readFileSync(join(ROOT, 'data/catalog/curation/synthetic-curation.json'), 'utf8'),
) as CurationManifest;

const SYNTHETIC_SOURCE: CatalogSourceDefinition = {
  sourceKey: SYNTHETIC_SOURCE_KEY,
  provider: 'synthetic_test',
  dataType: 'synthetic',
  releaseId: 'fixture-2026-08',
  licenseClass: 'synthetic_test_data',
  publicationScope: 'test_only',
  nutritionEvidence: 'synthetic_test',
  attribution: 'MACROS.AI synthetic test fixtures — NOT USDA',
  licenseVerification: { verifiedBy: 'engineering', verifiedOn: '2026-08-17', reference: 'in-house' },
};

// id | name | prep | kcal | protein | carb | fat
const FILE_V1 = [
  'SYN-001 | Chicken breast, cooked | cooked | 165 | 31   | 0  | 3.6',
  'SYN-002 | Chicken breast, raw    | raw    | 120 | 22.5 | 0  | 2.6',
  'SYN-003 | White rice, cooked     | cooked | 130 | 2.7  | 28 | 0.3',
].join('\n');

const EMPTY: CatalogState = { versions: [], heads: [] };

const runOnce = (contents: string, state: CatalogState = EMPTY, hash = 'hash-v1') =>
  runImport({
    source: SYNTHETIC_SOURCE,
    adapter: new SyntheticSourceAdapter(),
    fileContents: contents,
    sourceFileHash: hash,
    curation,
    state,
    nextVersionId: (productId, versionNo) => `${productId}@v${versionNo}`,
    effectiveFrom: '2026-08-17T00:00:00.000Z',
    mode: 'test',
  });

describe('SOURCE REGISTRY AND LICENCE', () => {
  test('USDA FDC is registered as public domain CC0, owner-verified', () => {
    const fdc = KNOWN_SOURCES.find((s) => s.sourceKey === 'usda_fdc.foundation_foods')!;
    assert.equal(fdc.licenseClass, 'public_domain_cc0');
    assert.equal(fdc.licenseVerification!.verifiedBy, 'owner');
    assert.equal(fdc.licenseVerification!.verifiedOn, '2026-08-17');
  });

  test('no source file exists yet, so the release is not claimed', () => {
    for (const s of KNOWN_SOURCES) assert.equal(s.releaseId, 'PENDING_SOURCE_FILE');
  });

  test('an unreviewed source may not be published from', () => {
    const unreviewed: CatalogSourceDefinition = {
      sourceKey: 'someone.else', provider: 'usda_fdc', dataType: 'branded',
      releaseId: 'r1', licenseClass: 'unreviewed', publicationScope: 'blocked',
      nutritionEvidence: 'estimated', attribution: 'unknown',
    };
    assert.equal(isPublishable(unreviewed), false);
    assert.throws(
      () => runImport({ ...runInputFor(unreviewed) }),
      /no verified licence/,
    );
  });

  const runInputFor = (source: CatalogSourceDefinition) => ({
    source,
    adapter: new SyntheticSourceAdapter(),
    fileContents: FILE_V1,
    sourceFileHash: 'h',
    curation,
    state: EMPTY,
    nextVersionId: (p: string, v: number) => `${p}@v${v}`,
    effectiveFrom: '2026-08-17T00:00:00.000Z',
    mode: 'test' as const,
  });

  test('a licence class is never inferred for a source nobody reviewed', () => {
    const unreviewed: CatalogSourceDefinition = {
      sourceKey: 'x', provider: 'usda_fdc', dataType: 'branded',
      releaseId: 'r', licenseClass: 'unreviewed', publicationScope: 'blocked',
      nutritionEvidence: 'estimated', attribution: '',
    };
    assert.equal(unreviewed.licenseVerification, undefined);
    assert.equal(isPublishable(unreviewed), false);
  });
});

describe('USDA ADAPTER IS DELIBERATELY UNIMPLEMENTED', () => {
  test('it refuses to run rather than guess nutrient ids from memory', () => {
    const adapter = new UsdaFdcAdapterPending('usda_fdc.foundation_foods');
    assert.throws(
      () => adapter.parse('anything', { releaseId: 'r', sourceFileHash: 'h' }),
      /not implemented/,
    );
  });
});

describe('INGESTION — first import', () => {
  test('publishes only curated records', () => {
    const { report, state } = runOnce(FILE_V1);
    assert.equal(report.recordsRead, 3);
    assert.equal(report.accepted, 3);
    assert.equal(report.newProducts, 3);
    assert.equal(state.versions.length, 3);
    assert.equal(state.heads.length, 3);
  });

  test('provenance is retained on every published version', () => {
    const { state } = runOnce(FILE_V1);
    for (const v of state.versions) {
      assert.equal(v.source.releaseId, 'fixture-2026-08');
      assert.equal(v.source.sourceFileHash, 'hash-v1');
      assert.ok(v.source.sourceId.length > 0, 'the source record id is retained');
      assert.match(v.labelFacts!.rawSourcePayloadRef!, /synthetic_test\.fixture_v1#SYN-/);
    }
  });

  test('synthetic records are never presented as USDA', () => {
    const { state } = runOnce(FILE_V1);
    for (const v of state.versions) {
      assert.equal(v.source.kind, 'synthetic_test');
      assert.equal(v.source.verificationStatus, 'synthetic_test');
      assert.equal(v.source.licenseClass, 'synthetic_test_data');
      assert.ok(!v.source.sourceId.startsWith('fdc'), 'no fabricated FDC identity');
    }
  });

  test('raw and cooked remain separate products, never yield-converted', () => {
    const { state } = runOnce(FILE_V1);
    const cooked = state.versions.find((v) => v.preparationState === 'cooked' && v.displayName.includes('Chicken'))!;
    const raw = state.versions.find((v) => v.preparationState === 'raw')!;
    assert.notEqual(cooked.productId, raw.productId);
    assert.notEqual(cooked.basis.kcal, raw.basis.kcal);
  });

  test('source-declared calories are carried through unchanged', () => {
    const { state } = runOnce(FILE_V1);
    const cooked = state.versions.find((v) => v.displayName === 'Chicken breast, cooked')!;
    assert.equal(cooked.basis.kcal, 165, 'the source value, not 31*4 + 3.6*9');
  });
});

describe('INGESTION — idempotency', () => {
  test('importing the same file twice creates no duplicates', () => {
    const first = runOnce(FILE_V1);
    const second = runOnce(FILE_V1, first.state);

    assert.equal(second.report.newProducts, 0);
    assert.equal(second.report.newVersions, 0);
    assert.equal(second.report.unchanged, 3);
    assert.equal(second.state.versions.length, 3, 'no duplicate versions');
    assert.equal(second.state.heads.length, 3, 'no duplicate products');
  });

  test('a later release with identical facts creates no meaningless version', () => {
    const first = runOnce(FILE_V1);
    const second = runImport({
      source: { ...SYNTHETIC_SOURCE, releaseId: 'fixture-2026-09' },
      adapter: new SyntheticSourceAdapter(),
      fileContents: FILE_V1,
      sourceFileHash: 'hash-v2-different-file',
      curation,
      state: first.state,
      nextVersionId: (p, v) => `${p}@v${v}`,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      mode: 'test',
    });
    assert.equal(second.report.newVersions, 0, 'import time is not a food fact');
    assert.equal(second.report.unchanged, 3);
  });
});

describe('INGESTION — correction creates V2 and never rewrites V1', () => {
  const CORRECTED = FILE_V1.replace('| 165 | 31   | 0  | 3.6', '| 172 | 32   | 0  | 3.8');

  test('changed facts produce a new version', () => {
    const first = runOnce(FILE_V1);
    const v1 = first.state.versions.find((v) => v.displayName === 'Chicken breast, cooked')!;

    const second = runOnce(CORRECTED, first.state, 'hash-v2');
    assert.equal(second.report.newVersions, 1);
    assert.equal(second.report.unchanged, 2);

    const stillV1 = second.state.versions.find((v) => v.productVersionId === v1.productVersionId)!;
    assert.equal(stillV1.basis.kcal, 165, 'V1 is never rewritten');

    const head = second.state.heads.find((h) => h.productId === v1.productId)!;
    assert.notEqual(head.currentProductVersionId, v1.productVersionId, 'the head advanced');
    const v2 = second.state.versions.find((v) => v.productVersionId === head.currentProductVersionId)!;
    assert.equal(v2.basis.kcal, 172);
    assert.equal(v2.versionNo, 2);
  });

  test('the old version stays resolvable for historical logs', () => {
    const first = runOnce(FILE_V1);
    const v1Id = first.state.versions.find((v) => v.displayName === 'Chicken breast, cooked')!.productVersionId;
    const second = runOnce(CORRECTED, first.state, 'hash-v2');
    assert.ok(
      second.state.versions.some((v) => v.productVersionId === v1Id),
      'a log referencing V1 must still resolve',
    );
  });

  test('the head advances only after a valid new version exists', () => {
    const first = runOnce(FILE_V1);
    const before = first.state.heads.find((h) => h.productId === 'syn-chicken-breast')!;
    const second = runOnce(CORRECTED, first.state, 'hash-v2');
    const after = second.state.heads.find((h) => h.productId === 'syn-chicken-breast')!;
    assert.ok(second.state.versions.some((v) => v.productVersionId === after.currentProductVersionId));
    assert.notEqual(after.currentProductVersionId, before.currentProductVersionId);
  });
});

describe('INGESTION — quarantine, never silent publication', () => {
  const badRecord = (line: string) => runOnce(line).report.records[0]!;

  test('a negative nutrient is rejected', () => {
    const r = badRecord('SYN-001 | Chicken breast, cooked | cooked | 165 | -31 | 0 | 3.6');
    assert.equal(r.outcome, 'rejected');
    assert.ok(r.reasons.includes('negative_nutrient'));
  });

  test('a non-finite nutrient is rejected', () => {
    const r = badRecord('SYN-001 | Chicken breast, cooked | cooked | abc | 31 | 0 | 3.6');
    assert.equal(r.outcome, 'rejected');
    assert.ok(r.reasons.includes('non_finite_nutrient'));
  });

  test('a missing required macro is rejected — never defaulted to zero', () => {
    const r = badRecord('SYN-001 | Chicken breast, cooked | cooked | 165 |  | 0 | 3.6');
    assert.equal(r.outcome, 'rejected');
    assert.ok(r.reasons.includes('missing_required_macro'));
  });

  test('missing energy is rejected — never computed from macros', () => {
    const r = badRecord('SYN-001 | Chicken breast, cooked | cooked |  | 31 | 0 | 3.6');
    assert.equal(r.outcome, 'rejected');
    assert.ok(r.reasons.includes('missing_energy'));
  });

  test('an ambiguous preparation state goes to curation, never published as a guess', () => {
    const r = badRecord('SYN-900 | Ambiguous food | ??? | 100 | 5 | 10 | 2');
    assert.equal(r.outcome, 'needs_curation');
    assert.ok(r.reasons.includes('ambiguous_preparation_state'));
    assert.equal(r.action, 'none');
  });

  test('a record with no curation decision is not published', () => {
    const r = badRecord('SYN-777 | Uncurated food | cooked | 100 | 5 | 10 | 2');
    assert.equal(r.outcome, 'needs_curation');
    assert.equal(r.action, 'none');
  });

  test('a curator rejection is honoured even though the record is valid', () => {
    const r = badRecord('SYN-901 | Rejected food | cooked | 100 | 5 | 10 | 2');
    assert.equal(r.action, 'none');
  });

  test('one malformed record does not stop the batch', () => {
    const mixed = [
      'SYN-001 | Chicken breast, cooked | cooked | 165 | 31 | 0 | 3.6',
      'SYN-002 | Chicken breast, raw    | raw    | 120 | -1 | 0 | 2.6',
      'SYN-003 | White rice, cooked     | cooked | 130 | 2.7 | 28 | 0.3',
    ].join('\n');
    const { report } = runOnce(mixed);
    assert.equal(report.recordsRead, 3);
    assert.equal(report.rejected, 1);
    assert.equal(report.accepted, 2, 'the good records still publish');
  });
});

describe('ATWATER IS A FLAG, NEVER AN OVERWRITE', () => {
  test('a large discrepancy is flagged but the source calories survive', () => {
    // Declared 400 kcal; macros imply ~165. Flagged, not corrected.
    const { report, state } = runOnce('SYN-001 | Chicken breast, cooked | cooked | 400 | 31 | 0 | 3.6');
    assert.equal(report.accepted, 1);
    assert.ok(report.records[0]!.flags.includes('atwater_discrepancy'));
    assert.equal(state.versions[0]!.basis.kcal, 400, 'the source value is untouched');
  });

  test('the delta is computed, not applied', () => {
    const delta = atwaterDeltaFraction({
      raw: { sourceKey: 's', provider: 'synthetic_test', dataType: 'synthetic', releaseId: 'r', sourceRecordId: 'i', sourceFileHash: 'h', fields: {} },
      displayName: 'x',
      preparationState: 'cooked',
      per100g: { kcal: 400, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
      nutrientProvenance: {},
    });
    assert.ok(delta !== null && delta > 0.25);
  });
});

describe('IDENTITY AND DEDUPLICATION', () => {
  test('the canonical fingerprint ignores import metadata', () => {
    const base = {
      raw: { sourceKey: 's', provider: 'synthetic_test' as const, dataType: 'synthetic' as const, releaseId: 'r1', sourceRecordId: 'i', sourceFileHash: 'h1', fields: {} },
      displayName: 'Chicken breast, cooked',
      preparationState: 'cooked' as const,
      per100g: { kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
      nutrientProvenance: {},
    };
    const later = { ...base, raw: { ...base.raw, releaseId: 'r2', sourceFileHash: 'h2' } };
    assert.equal(
      canonicalFingerprint(base, base.displayName, 'cooked'),
      canonicalFingerprint(later, later.displayName, 'cooked'),
      'a new release with identical facts is the same food',
    );
  });

  test('foods with the same name but different preparation never collapse', () => {
    const shared = {
      raw: { sourceKey: 's', provider: 'synthetic_test' as const, dataType: 'synthetic' as const, releaseId: 'r', sourceRecordId: 'i', sourceFileHash: 'h', fields: {} },
      displayName: 'Chicken breast',
      per100g: { kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
      nutrientProvenance: {},
    };
    assert.notEqual(
      canonicalFingerprint({ ...shared, preparationState: 'cooked' }, 'Chicken breast', 'cooked'),
      canonicalFingerprint({ ...shared, preparationState: 'raw' }, 'Chicken breast', 'raw'),
    );
  });

  test('the source record id is provenance, not our product identity', () => {
    const { state } = runOnce(FILE_V1);
    const v = state.versions.find((x) => x.source.sourceId === 'SYN-001')!;
    assert.equal(v.productId, 'syn-chicken-breast', 'assigned by curation, not by the source');
    assert.notEqual(v.productId, v.source.sourceId);
  });
});

describe('SEARCH PROJECTION', () => {
  test('only versions behind an active head are searchable', () => {
    const { state } = runOnce(FILE_V1);
    const heads = state.heads.map((h) =>
      h.productId === 'syn-white-rice' ? { ...h, isActive: false } : h,
    );
    const docs = buildSearchProjection({ versions: state.versions, heads, aliasSets: [] });
    assert.equal(docs.length, 2);
    assert.ok(!docs.some((d) => d.displayName.includes('rice')), 'a de-listed food is hidden');
  });

  test('superseded versions are not searchable but remain resolvable', () => {
    const first = runOnce(FILE_V1);
    const v1Id = first.state.versions.find((v) => v.displayName === 'Chicken breast, cooked')!.productVersionId;
    const second = runOnce(FILE_V1.replace('| 165 | 31   | 0  | 3.6', '| 172 | 32   | 0  | 3.8'), first.state, 'h2');

    const docs = buildSearchProjection({ versions: second.state.versions, heads: second.state.heads, aliasSets: [] });
    assert.ok(!docs.some((d) => d.productVersionId === v1Id), 'V1 is not a search result');
    assert.ok(second.state.versions.some((v) => v.productVersionId === v1Id), 'V1 still resolves by id');
  });

  test('the projection is deterministic', () => {
    const { state } = runOnce(FILE_V1);
    const a = buildSearchProjection({ ...state, aliasSets: [] });
    const b = buildSearchProjection({ versions: [...state.versions].reverse(), heads: [...state.heads].reverse(), aliasSets: [] });
    assert.deepEqual(a.map((d) => d.productVersionId), b.map((d) => d.productVersionId));
  });
});

describe('QUALITY REPORT', () => {
  test('reports counted facts, not invented scores', () => {
    const { state } = runOnce(FILE_V1);
    const report = buildQualityReport({
      versions: state.versions, heads: state.heads, unresolvedCurationCount: 2, search: null,
    });
    assert.equal(report.catalogSize, 3);
    assert.equal(report.activeProducts, 3);
    assert.equal(report.preparationStateDistribution['cooked'], 2);
    assert.equal(report.preparationStateDistribution['raw'], 1);
    assert.equal(report.sourceDistribution['synthetic_test'], 3);
    assert.equal(report.unresolvedCurationCount, 2);
    assert.equal(report.missingNutrientRate, 1, 'the fixtures declare no fibre/sugar/sodium');
  });
});

describe('CANDIDATE ASSESSMENT', () => {
  test('a clean candidate is accepted', () => {
    const a = assessCandidate({
      raw: { sourceKey: 's', provider: 'synthetic_test', dataType: 'synthetic', releaseId: 'r', sourceRecordId: 'i', sourceFileHash: 'h', fields: {} },
      displayName: 'Food',
      preparationState: 'cooked',
      per100g: { kcal: 100, proteinG: 5, carbohydrateG: 10, fatG: 4 },
      nutrientProvenance: {},
    });
    assert.equal(a.outcome, 'accepted');
  });

  test('mass balance beyond 100 g per 100 g is rejected', () => {
    const a = assessCandidate({
      raw: { sourceKey: 's', provider: 'synthetic_test', dataType: 'synthetic', releaseId: 'r', sourceRecordId: 'i', sourceFileHash: 'h', fields: {} },
      displayName: 'Impossible',
      preparationState: 'cooked',
      per100g: { kcal: 500, proteinG: 60, carbohydrateG: 60, fatG: 20 },
      nutrientProvenance: {},
    });
    assert.equal(a.outcome, 'rejected');
    assert.ok(a.reasons.includes('mass_balance_exceeded'));
  });
});
