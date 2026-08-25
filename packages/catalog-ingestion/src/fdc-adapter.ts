import type { ParseContext, RawSourceRecord, SourceAdapter } from '@macros/domain-catalog';

/**
 * USDA FoodData Central adapter — BOUNDARY ONLY, DELIBERATELY UNIMPLEMENTED.
 *
 * Writing this parser requires the ACTUAL FDC file and its schema in front of
 * us: the nutrient identifiers, the energy-nutrient rows (FDC publishes more
 * than one energy representation), the per-100 g basis columns, and the
 * data-type-specific layout.
 *
 * Hard-coding nutrient ids from memory to make an importer "work" would produce
 * confident, wrong food data attributed to USDA. That is worse than having no
 * importer, so this throws until a real file is supplied.
 *
 * When the file arrives:
 *   1. inspect the actual schema and record it,
 *   2. write the field mapping against what was inspected,
 *   3. add golden parser tests from real excerpts,
 *   4. only then enable publication.
 */
export class UsdaFdcAdapterPending implements SourceAdapter {
  constructor(readonly sourceKey: string) {}

  parse(_fileContents: string, _context: ParseContext): readonly RawSourceRecord[] {
    throw new Error(
      'UsdaFdcAdapter: not implemented. The nutrient/field mapping must be written against an ' +
        'inspected USDA FoodData Central source file — never from memory. ' +
        'Supply the source file and schema, then implement parse() and normalize().',
    );
  }

  normalize(_record: RawSourceRecord): never {
    throw new Error('UsdaFdcAdapter: not implemented — see parse().');
  }
}
