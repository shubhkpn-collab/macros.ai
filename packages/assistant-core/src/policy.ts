import type { ParseResult } from '@macros/domain-voice';

/**
 * WHEN THE ASSISTANT IS ALLOWED TO RUN.
 *
 * PURE. The deterministic parser is the fast path: cheap, offline and
 * high-confidence. The interpreter is a fallback for language the grammar
 * cannot cover — never a second opinion on a decision already made safely.
 */
export type FallbackDecision =
  | { readonly use: false; readonly why: 'deterministic_understood' | 'deterministic_refusal' }
  | { readonly use: true };

export function shouldConsultAssistant(parsed: ParseResult): FallbackDecision {
  switch (parsed.status) {
    case 'understood':
      // Already understood safely. Asking a model to re-decide would only add a
      // way to get it wrong.
      return { use: false, why: 'deterministic_understood' };

    case 'invalid':
      // A HARD SAFETY REFUSAL: negative weight, unsupported unit, empty
      // transcript. A model may never overturn these.
      return { use: false, why: 'deterministic_refusal' };

    case 'needs_clarification':
      // Structural ambiguity — "option A or B", "log something". The user named
      // two things or nothing; a model guessing between them is precisely the
      // overreach the clarification exists to prevent.
      return { use: false, why: 'deterministic_refusal' };

    case 'unsupported':
      // Natural phrasing the grammar does not cover. This is the ONLY case where
      // richer interpretation adds something.
      return { use: true };
  }
}
