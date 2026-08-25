/**
 * Minimal Result type. Validation never throws on user-supplied data; it
 * returns structured failures so callers can decide what to do.
 */
export type Result<T, E = ValidationIssue[]> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationCode;
  readonly message: string;
}

export type ValidationCode =
  | 'required'
  | 'not_finite'
  | 'out_of_range'
  | 'invalid_enum'
  | 'invalid_combination'
  | 'policy_not_approved'
  | 'policy_not_production';

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (issues: ValidationIssue[]): Result<never> => ({ ok: false, error: issues });

export const issue = (path: string, code: ValidationCode, message: string): ValidationIssue => ({
  path,
  code,
  message,
});

/** Throws on failure. Only for trusted internal data and tests, never user input. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  const detail = r.error.map((i) => `${i.path}: ${i.message}`).join('; ');
  throw new Error(`Contract validation failed — ${detail}`);
}
