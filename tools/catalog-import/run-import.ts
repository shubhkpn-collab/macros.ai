/**
 * CATALOG IMPORT CLI — the IO boundary.
 *
 * File reading, hashing and id generation live here. Everything downstream is
 * pure: parsing, validation, canonicalization and versioning receive data and
 * return data. This script writes report artifacts; it never writes to a
 * database.
 *
 * Usage:
 *   node --import tsx tools/catalog-import/run-import.ts <sourceKey> <file>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildQualityReport,
  runBenchmark,
  runImport,
  SyntheticSourceAdapter,
  SYNTHETIC_SOURCE_KEY,
  UsdaFdcAdapterPending,
  type BenchmarkCorpus,
  type CatalogState,
} from '@macros/catalog-ingestion';
import {
  buildSearchProjection,
  KNOWN_SOURCES,
  type CatalogAliasSet,
  type CatalogSourceDefinition,
  type CurationManifest,
  type SourceAdapter,
} from '@macros/domain-catalog';

const ROOT = new URL('../..', import.meta.url).pathname;
const DATA = join(ROOT, 'data/catalog');

/** Provenance, not blockchain: a deterministic hash of the file we actually read. */
export function hashSourceFile(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

function adapterFor(sourceKey: string): SourceAdapter {
  if (sourceKey === SYNTHETIC_SOURCE_KEY) return new SyntheticSourceAdapter();
  if (sourceKey.startsWith('usda_fdc.')) return new UsdaFdcAdapterPending(sourceKey);
  throw new Error(`No adapter registered for source "${sourceKey}"`);
}

function sourceFor(sourceKey: string): CatalogSourceDefinition {
  const known = KNOWN_SOURCES.find((s) => s.sourceKey === sourceKey);
  if (known !== undefined) return known;
  const registry = JSON.parse(
    readFileSync(join(DATA, 'source-registry/registry.json'), 'utf8'),
  ) as { sources: CatalogSourceDefinition[] };
  const found = registry.sources.find((s) => s.sourceKey === sourceKey);
  if (found === undefined) throw new Error(`Source "${sourceKey}" is not registered`);
  return found;
}

export function main(argv: readonly string[]): void {
  const [sourceKey, filePath] = argv;
  if (sourceKey === undefined || filePath === undefined) {
    console.error('usage: run-import.ts <sourceKey> <sourceFile>');
    process.exit(2);
    return;
  }

  const contents = readFileSync(filePath, 'utf8');
  const sourceFileHash = hashSourceFile(contents);

  const curation = JSON.parse(
    readFileSync(join(DATA, 'curation/synthetic-curation.json'), 'utf8'),
  ) as CurationManifest;

  const empty: CatalogState = { versions: [], heads: [] };
  const { report, state } = runImport({
    source: sourceFor(sourceKey),
    adapter: adapterFor(sourceKey),
    fileContents: contents,
    sourceFileHash,
    curation,
    state: empty,
    nextVersionId: (productId, versionNo) => `${productId}@v${versionNo}`,
    effectiveFrom: new Date().toISOString(),
  });

  const aliasSets = (
    JSON.parse(readFileSync(join(DATA, 'aliases/synthetic-aliases.json'), 'utf8')) as {
      aliasSets: CatalogAliasSet[];
    }
  ).aliasSets;
  const corpus = JSON.parse(
    readFileSync(join(DATA, 'benchmarks/search-benchmark.json'), 'utf8'),
  ) as BenchmarkCorpus;

  const projection = buildSearchProjection({ versions: state.versions, heads: state.heads, aliasSets });

  // A benchmark corpus names exact productVersionIds, so it only scores the
  // catalog it was authored against. Running it against a different catalog
  // yields 0% — a meaningless number that looks like a quality result. Report
  // the mismatch instead.
  const corpusTargets = new Set(
    corpus.cases.flatMap((c) => c.acceptableProductVersionIds),
  );
  const projected = new Set(projection.map((d) => d.productVersionId));
  const corpusMatchesCatalog =
    corpusTargets.size > 0 && [...corpusTargets].some((id) => projected.has(id));
  const search = corpusMatchesCatalog ? runBenchmark(corpus, projection) : null;
  const quality = buildQualityReport({
    versions: state.versions,
    heads: state.heads,
    unresolvedCurationCount: report.needsCuration,
    search,
  });

  mkdirSync(join(DATA, 'reports'), { recursive: true });
  writeFileSync(join(DATA, 'reports/import-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(DATA, 'reports/catalog-quality.json'), JSON.stringify(quality, null, 2));

  console.log(`imported ${report.recordsRead} records from ${sourceKey}`);
  console.log(`  accepted ${report.accepted} · rejected ${report.rejected} · needs curation ${report.needsCuration}`);
  console.log(`  new products ${report.newProducts} · new versions ${report.newVersions} · unchanged ${report.unchanged}`);
  if (search === null) {
    console.log('  search benchmark SKIPPED — the corpus targets a different catalog');
  } else {
    const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
    console.log(`  search top-1 ${pct(search.top1HitRate)} · top-4 ${pct(search.top4Recall)}`);
  }
}

if (process.argv[1]?.endsWith('run-import.ts') === true) {
  main(process.argv.slice(2));
}
