import type {
  NormalizedCandidate,
  ParseContext,
  RawSourceRecord,
  SourceAdapter,
} from '@macros/domain-catalog';

/**
 * SYNTHETIC SOURCE ADAPTER — TEST FIXTURE FORMAT ONLY.
 *
 * Exercises every pipeline stage without pretending to be USDA data. Records
 * parsed here are tagged `synthetic_test` end to end: source key, provider,
 * verification status and licence class all say synthetic, so a synthetic food
 * can never be presented as source-backed USDA nutrition.
 *
 * Line format (deliberately not any real source's format):
 *   id | displayName | prep | kcal | protein | carb | fat [| fiber | sugar | sodium]
 */
export const SYNTHETIC_SOURCE_KEY = 'synthetic_test.fixture_v1';

export class SyntheticSourceAdapter implements SourceAdapter {
  readonly sourceKey = SYNTHETIC_SOURCE_KEY;

  parse(fileContents: string, context: ParseContext): readonly RawSourceRecord[] {
    const out: RawSourceRecord[] = [];
    for (const line of fileContents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const cells = trimmed.split('|').map((c) => c.trim());
      const [id, displayName, prep, kcal, protein, carb, fat, fiber, sugar, sodium] = cells;
      out.push({
        sourceKey: this.sourceKey,
        provider: 'synthetic_test',
        dataType: 'synthetic',
        releaseId: context.releaseId,
        sourceRecordId: id ?? '',
        sourceFileHash: context.sourceFileHash,
        fields: { id, displayName, prep, kcal, protein, carb, fat, fiber, sugar, sodium },
      });
    }
    return out;
  }

  normalize(record: RawSourceRecord): NormalizedCandidate {
    const f = record.fields as Record<string, string | undefined>;

    // A blank cell means the source did not state the value. It stays ABSENT —
    // an adapter may never invent a nutrient, and zero is a different claim.
    const num = (v: string | undefined): number | undefined => {
      if (v === undefined || v === '') return undefined;
      return Number(v);
    };

    const prep = f['prep'];
    const preparationState: NormalizedCandidate['preparationState'] =
      prep === 'raw' || prep === 'cooked' || prep === 'prepared' || prep === 'as_sold'
        ? prep
        : 'unresolved';

    return {
      raw: record,
      displayName: f['displayName'] ?? '',
      preparationState,
      per100g: {
        ...(num(f['kcal']) !== undefined ? { kcal: num(f['kcal'])! } : {}),
        ...(num(f['protein']) !== undefined ? { proteinG: num(f['protein'])! } : {}),
        ...(num(f['carb']) !== undefined ? { carbohydrateG: num(f['carb'])! } : {}),
        ...(num(f['fat']) !== undefined ? { fatG: num(f['fat'])! } : {}),
        ...(num(f['fiber']) !== undefined ? { fiberG: num(f['fiber'])! } : {}),
        ...(num(f['sugar']) !== undefined ? { sugarG: num(f['sugar'])! } : {}),
        ...(num(f['sodium']) !== undefined ? { sodiumMg: num(f['sodium'])! } : {}),
      },
      nutrientProvenance: {
        kcal: 'column:kcal',
        proteinG: 'column:protein',
        carbohydrateG: 'column:carb',
        fatG: 'column:fat',
      },
    };
  }
}
