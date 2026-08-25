import type { CatalogDataType, CatalogProvider } from './source-registry.js';

/**
 * A RAW SOURCE RECORD, exactly as the adapter read it.
 *
 * Kept so a canonical ProductVersion can always be explained back to what the
 * source actually said. We retain the identity and the facts needed to audit
 * the transformation — not a duplicated copy of the whole dataset in every row.
 */
export interface RawSourceRecord {
  readonly sourceKey: string;
  readonly provider: CatalogProvider;
  readonly dataType: CatalogDataType;
  readonly releaseId: string;
  /** The source's own identifier — provenance, NOT our product identity. */
  readonly sourceRecordId: string;
  readonly sourceFileHash: string;
  /** The source's own fields, untouched, for audit. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * A normalized candidate: what the adapter believes the record means, before
 * validation and curation. Not yet a ProductVersion, and not yet publishable.
 */
export interface NormalizedCandidate {
  readonly raw: RawSourceRecord;
  readonly displayName: string;
  readonly brandName?: string;
  /** Never guessed — 'unresolved' routes to curation instead of publishing. */
  readonly preparationState: 'raw' | 'cooked' | 'prepared' | 'as_sold' | 'unresolved';
  /** Per 100 g, mapped from the source. Missing nutrients are ABSENT, never zero. */
  readonly per100g: {
    readonly kcal?: number;
    readonly proteinG?: number;
    readonly carbohydrateG?: number;
    readonly fatG?: number;
    readonly fiberG?: number;
    readonly sugarG?: number;
    readonly sodiumMg?: number;
    /**
     * Everything beyond the legacy shorthand fields, keyed by canonical
     * MACROS.AI nutrient id. Absent means the source did not report it.
     */
    readonly extended?: Readonly<Record<string, {
      readonly nutrientId: string;
      readonly amount: number;
      readonly unit: string;
      readonly source?: Readonly<Record<string, unknown>>;
    }>>;
  };
  /** Branded identification, label and package facts, when the source has them. */
  readonly manufacturerName?: string;
  readonly variant?: string;
  readonly packageDescriptor?: string;
  readonly labelFacts?: import('./branded.js').PackageLabelFacts;
  readonly identifiers?: readonly import('./identifiers.js').ExternalProductIdentifier[];
  /** Which source field each canonical nutrient came from. */
  readonly nutrientProvenance: Readonly<Record<string, string>>;
  /** The source's own declared per-100 basis, retained verbatim for audit. */
  readonly declaredPer100?: import('@macros/contracts').NutrientBasis;
}

/**
 * A SOURCE ADAPTER.
 *
 * One per source family. Parsing is the ONLY thing it does: no nutrition
 * arithmetic, no curation, no writes. A missing nutrient stays missing —
 * an adapter may never invent one, and may never substitute macro arithmetic
 * for a source-declared energy value.
 */
export interface SourceAdapter {
  readonly sourceKey: string;
  parse(fileContents: string, context: ParseContext): readonly RawSourceRecord[];
  normalize(record: RawSourceRecord): NormalizedCandidate;
}

export interface ParseContext {
  readonly releaseId: string;
  readonly sourceFileHash: string;
}
