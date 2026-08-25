import { appError, type AppError } from '@macros/runtime-config';

/**
 * RUNTIME INPUT VALIDATION.
 *
 * TypeScript types are erased at runtime, so a network payload is `unknown`
 * until proven otherwise. Hand-rolled and dependency-free: no validation
 * library is installable in this environment, and adding a second one later
 * would create competing sources of truth.
 */

export interface FieldSpec {
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'uuid' | 'instant' | 'enum';
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
}

export type Schema = Readonly<Record<string, FieldSpec>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateBody(
  body: unknown,
  schema: Schema,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: AppError } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: appError('validation', 'invalid_body', 'Request body must be an object.') };
  }
  const input = body as Record<string, unknown>;

  // Unknown fields are REJECTED, not ignored: silently dropping an unexpected
  // field is how a client believes it set something it did not.
  for (const key of Object.keys(input)) {
    if (!(key in schema)) {
      return { ok: false, error: appError('validation', 'unknown_field', `Unexpected field: ${key}`) };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const raw = input[name];
    if (raw === undefined || raw === null) {
      if (spec.required === true) {
        return { ok: false, error: appError('validation', 'missing_field', `Missing required field: ${name}`) };
      }
      continue;
    }
    const bad = (why: string): { ok: false; error: AppError } =>
      ({ ok: false, error: appError('validation', 'invalid_field', `${name}: ${why}`) });

    switch (spec.type) {
      case 'string':
      case 'uuid':
      case 'instant':
      case 'enum': {
        if (typeof raw !== 'string') return bad('must be a string');
        if (spec.maxLength !== undefined && raw.length > spec.maxLength) return bad('too long');
        if (spec.type === 'uuid' && !UUID.test(raw)) return bad('must be a UUID');
        if (spec.type === 'instant' && !Number.isFinite(Date.parse(raw))) return bad('must be a timestamp');
        if (spec.type === 'enum' && !(spec.values ?? []).includes(raw)) return bad('not an allowed value');
        out[name] = raw;
        break;
      }
      case 'integer':
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return bad('must be a finite number');
        if (spec.type === 'integer' && !Number.isInteger(raw)) return bad('must be an integer');
        if (spec.min !== undefined && raw < spec.min) return bad('below minimum');
        if (spec.max !== undefined && raw > spec.max) return bad('above maximum');
        out[name] = raw;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') return bad('must be a boolean');
        out[name] = raw;
        break;
      }
    }
  }
  return { ok: true, value: out };
}
