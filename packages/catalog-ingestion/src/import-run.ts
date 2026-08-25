import type { ProductCatalogHead, ProductVersion } from '@macros/contracts';
import {
  advanceHead,
  assertPublishable,
  assessCandidate,
  canonicalSourceKind,
  verificationStatusFor,
  canonicalFingerprint,
  canonicalize,
  findCuration,
  type CandidateOutcome,
  type CandidateReason,
  type CatalogSourceDefinition,
  type CurationManifest,
  type NormalizedCandidate,
  type ImportMode,
  type SourceAdapter,
} from '@macros/domain-catalog';

export const CATALOG_IMPORT_VERSION = 'catalog-import@1.0.0';

export interface ImportRecordOutcome {
  readonly sourceRecordId: string;
  readonly outcome: CandidateOutcome;
  readonly reasons: readonly CandidateReason[];
  readonly flags: readonly CandidateReason[];
  readonly action: 'new_product' | 'new_version' | 'unchanged' | 'none';
  readonly productVersionId?: string;
}

export interface ImportReport {
  readonly sourceKey: string;
  readonly releaseId: string;
  readonly sourceFileHash: string;
  readonly recordsRead: number;
  readonly accepted: number;
  readonly rejected: number;
  /** Explicitly declined by a curator — distinct from awaiting review. */
  readonly curatorRejected: number;
  readonly needsCuration: number;
  readonly newProducts: number;
  readonly newVersions: number;
  readonly unchanged: number;
  readonly records: readonly ImportRecordOutcome[];
}

export interface CatalogState {
  readonly versions: readonly ProductVersion[];
  readonly heads: readonly ProductCatalogHead[];
}

export interface ImportRunInput {
  readonly source: CatalogSourceDefinition;
  readonly adapter: SourceAdapter;
  readonly fileContents: string;
  readonly sourceFileHash: string;
  readonly curation: CurationManifest;
  readonly state: CatalogState;
  /** Ids and time arrive from the edge; this stage stays deterministic. */
  readonly nextVersionId: (productId: string, versionNo: number) => string;
  readonly effectiveFrom: string;
  /** Production refuses test-only sources outright. Defaults to production. */
  readonly mode?: ImportMode;
}

export interface ImportRunResult {
  readonly report: ImportReport;
  readonly state: CatalogState;
}

/**
 * ONE DETERMINISTIC IMPORT RUN.
 *
 * Stages stay separable: the adapter parses and normalizes, validation judges,
 * curation decides, canonicalization versions. No stage writes to a database,
 * performs nutrition arithmetic, or reads a clock.
 *
 * IDEMPOTENT: re-running the same file against the same catalog produces no new
 * products, no new versions, and no duplicate aliases — because the decision is
 * made on the canonical FOOD FACTS, not on import time.
 */
export function runImport(input: ImportRunInput): ImportRunResult {
  const mode: ImportMode = input.mode ?? 'production';
  assertPublishable(input.source, mode);

  // ADAPTER <-> SOURCE binding. An adapter registered for one source may not
  // produce records under another source's provenance.
  if (input.adapter.sourceKey !== input.source.sourceKey) {
    throw new Error(
      `runImport: adapter "${input.adapter.sourceKey}" does not belong to source "${input.source.sourceKey}"`,
    );
  }

  const raw = input.adapter.parse(input.fileContents, {
    releaseId: input.source.releaseId,
    sourceFileHash: input.sourceFileHash,
  });

  const versions = [...input.state.versions];
  const heads = [...input.state.heads];
  const records: ImportRecordOutcome[] = [];
  let accepted = 0, rejected = 0, needsCuration = 0, curatorRejected = 0;
  let newProducts = 0, newVersions = 0, unchanged = 0;

  for (const record of raw) {
    // RECORD <-> SOURCE binding. A record claiming another source, provider,
    // data type, release or file is never normalized under this caller's
    // provenance — that is how one source silently masquerades as another.
    const mismatch =
      record.sourceKey !== input.source.sourceKey ? 'sourceKey' :
      record.provider !== input.source.provider ? 'provider' :
      record.dataType !== input.source.dataType ? 'dataType' :
      record.releaseId !== input.source.releaseId ? 'releaseId' :
      record.sourceFileHash !== input.sourceFileHash ? 'sourceFileHash' :
      null;

    if (mismatch !== null) {
      rejected += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'rejected',
        reasons: ['invalid_source_identity'],
        flags: [],
        action: 'none',
      });
      continue;
    }

    const candidate: NormalizedCandidate = input.adapter.normalize(record);
    const assessment = assessCandidate(candidate);

    if (assessment.outcome === 'rejected') {
      rejected += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'rejected',
        reasons: assessment.reasons,
        flags: assessment.flags,
        action: 'none',
      });
      continue;
    }

    const curation = findCuration(input.curation, record.sourceKey, record.sourceRecordId);

    // A curator saying "do not publish this" is NOT the same state as "nobody
    // has looked at it yet". Reporting them together hides real review progress.
    if (curation !== undefined && curation.decision === 'reject') {
      curatorRejected += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'rejected',
        reasons: ['curator_rejected'],
        flags: assessment.flags,
        action: 'none',
      });
      continue;
    }

    // Source availability is not publication.
    if (curation === undefined || curation.decision !== 'publish') {
      needsCuration += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'needs_curation',
        reasons: ['awaiting_curation'],
        flags: assessment.flags,
        action: 'none',
      });
      continue;
    }

    if (assessment.outcome === 'needs_curation') {
      needsCuration += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'needs_curation',
        reasons: assessment.reasons,
        flags: assessment.flags,
        action: 'none',
      });
      continue;
    }

    const headIndex = heads.findIndex((h) => h.productId === curation.productId);
    const head = headIndex === -1 ? null : heads[headIndex]!;
    const currentVersion =
      head === null
        ? null
        : versions.find((v) => v.productVersionId === head.currentProductVersionId) ?? null;

    const displayName = curation.displayName ?? candidate.displayName;
    const preparationState = curation.preparationState ?? candidate.preparationState;
    const currentFingerprint =
      currentVersion === null
        ? null
        : canonicalFingerprint(
            { ...candidate, per100g: basisToPer100g(currentVersion) },
            currentVersion.displayName,
            currentVersion.preparationState,
          );

    const decision = canonicalize({
      candidate,
      curation,
      currentVersion,
      currentFingerprint,
      nextVersionId: input.nextVersionId(curation.productId, (currentVersion?.versionNo ?? 0) + 1),
      effectiveFrom: input.effectiveFrom,
      sourceKind: canonicalSourceKind(input.source) as ProductVersion['source']['kind'],
      // Derived from the source's EVIDENCE class, never from the fact that its
      // licence was reviewed or its schema validated.
      verificationStatus: verificationStatusFor(input.source) as ProductVersion['source']['verificationStatus'],
      licenseClass: input.source.licenseClass,
    });

    accepted += 1;
    void displayName;
    void preparationState;

    if (decision.kind === 'unchanged') {
      unchanged += 1;
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'accepted',
        reasons: ['ok'],
        flags: assessment.flags,
        action: 'unchanged',
        productVersionId: decision.productVersionId,
      });
      continue;
    }

    // A new version is ADDED. The previous one is never rewritten; only the
    // mutable head moves.
    versions.push(decision.productVersion);
    const versionId = decision.productVersion.productVersionId;

    if (head === null) {
      newProducts += 1;
      heads.push({
        productId: curation.productId,
        currentProductVersionId: versionId,
        isActive: true,
        updatedAt: input.effectiveFrom as ProductCatalogHead['updatedAt'],
      });
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'accepted',
        reasons: ['ok'],
        flags: assessment.flags,
        action: 'new_product',
        productVersionId: versionId,
      });
    } else {
      newVersions += 1;
      heads[headIndex] = advanceHead(head, versionId);
      records.push({
        sourceRecordId: record.sourceRecordId,
        outcome: 'accepted',
        reasons: ['ok'],
        flags: assessment.flags,
        action: 'new_version',
        productVersionId: versionId,
      });
    }
  }

  return {
    report: {
      sourceKey: input.source.sourceKey,
      releaseId: input.source.releaseId,
      sourceFileHash: input.sourceFileHash,
      recordsRead: raw.length,
      accepted,
      rejected,
      curatorRejected,
      needsCuration,
      newProducts,
      newVersions,
      unchanged,
      records,
    },
    state: { versions, heads },
  };
}

function basisToPer100g(v: ProductVersion): NormalizedCandidate['per100g'] {
  return {
    kcal: v.basis.kcal,
    proteinG: v.basis.proteinG,
    carbohydrateG: v.basis.carbohydrateG,
    fatG: v.basis.fatG,
    ...(v.basis.fiberG !== undefined ? { fiberG: v.basis.fiberG } : {}),
    ...(v.basis.sugarG !== undefined ? { sugarG: v.basis.sugarG } : {}),
    ...(v.basis.sodiumMg !== undefined ? { sodiumMg: v.basis.sodiumMg } : {}),
  };
}

