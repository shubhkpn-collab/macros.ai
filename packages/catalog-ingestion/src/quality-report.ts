import type { ProductCatalogHead, ProductVersion } from '@macros/contracts';
import type { BenchmarkMetrics } from './benchmark.js';

/**
 * Catalog quality report. Every figure is a counted fact — there are no
 * invented "quality scores" whose meaning nobody has defined.
 */
export interface CatalogQualityReport {
  readonly catalogSize: number;
  readonly activeProducts: number;
  readonly totalVersions: number;
  readonly preparationStateDistribution: Readonly<Record<string, number>>;
  readonly sourceDistribution: Readonly<Record<string, number>>;
  readonly missingNutrientRate: number;
  readonly duplicateCandidateCount: number;
  readonly unresolvedCurationCount: number;
  readonly search: BenchmarkMetrics | null;
}

export interface QualityReportInput {
  readonly versions: readonly ProductVersion[];
  readonly heads: readonly ProductCatalogHead[];
  readonly unresolvedCurationCount: number;
  readonly search: BenchmarkMetrics | null;
}

export function buildQualityReport(input: QualityReportInput): CatalogQualityReport {
  const activeHeads = input.heads.filter((h) => h.isActive);
  const current = new Set(activeHeads.map((h) => h.currentProductVersionId));
  const currentVersions = input.versions.filter((v) => current.has(v.productVersionId));

  const preparation: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let missingNutrient = 0;

  for (const v of currentVersions) {
    preparation[v.preparationState] = (preparation[v.preparationState] ?? 0) + 1;
    sources[v.source.kind] = (sources[v.source.kind] ?? 0) + 1;
    const b = v.basis;
    if (b.fiberG === undefined || b.sugarG === undefined || b.sodiumMg === undefined) missingNutrient += 1;
  }

  // Same name AND same preparation state is a duplicate CANDIDATE only — it is
  // never merged automatically, because equal names do not mean equal foods.
  const byKey = new Map<string, number>();
  for (const v of currentVersions) {
    const key = `${v.displayName.trim().toLowerCase()}|${v.preparationState}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const duplicateCandidateCount = [...byKey.values()].filter((n) => n > 1).length;

  return {
    catalogSize: currentVersions.length,
    activeProducts: activeHeads.length,
    totalVersions: input.versions.length,
    preparationStateDistribution: preparation,
    sourceDistribution: sources,
    missingNutrientRate: currentVersions.length === 0 ? 0 : missingNutrient / currentVersions.length,
    duplicateCandidateCount,
    unresolvedCurationCount: input.unresolvedCurationCount,
    search: input.search,
  };
}
