import { redactConfig } from './config.js';

/**
 * STRUCTURED LOGGING FOUNDATION.
 *
 * Small on purpose: a correct abstraction with correct privacy rules, not a
 * telemetry platform.
 *
 * PRIVACY IS ENFORCED, NOT DOCUMENTED. On a nutrition appliance the sensitive
 * material is exactly the material engineers most want in logs — what someone
 * said and what they ate. Those fields are stripped by the logger itself, so a
 * future call site cannot leak them by forgetting.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly requestId?: string;
  /** Pseudonymous, never the raw user id. */
  readonly subjectRef?: string;
  readonly durationMs?: number;
  readonly result?: 'ok' | 'refused' | 'error';
  readonly errorCode?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * Fields never logged, by name. Raw transcripts, nutrition detail, tokens and
 * credentials are all excluded regardless of what a caller passes.
 */
const FORBIDDEN_FIELD = /(transcript|utterance|speech|token|secret|password|apikey|api_key|credential|authorization|cookie|email|dob|dateofbirth|kcal|calories|protein|carbohydrate|fat|weight|grams|nutrition|profile)/i;

export const scrubFields = (
  fields: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined => {
  if (fields === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(k)) { out[k] = '[omitted]'; continue; }
    if (v !== null && typeof v === 'object') {
      out[k] = redactConfig(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
};

/**
 * A stable pseudonymous reference for a user id.
 *
 * Deterministic so events correlate across a session, and one-way so logs never
 * become a user directory. Not a security primitive — a log hygiene one.
 */
export function subjectRef(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `subj_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export interface LogSink {
  write(record: Readonly<Record<string, unknown>>): void;
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export class StructuredLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = 'info',
  ) {}

  log(event: LogEvent): void {
    if (ORDER[event.level] < ORDER[this.minLevel]) return;
    const scrubbed = scrubFields(event.fields);
    this.sink.write({
      level: event.level,
      component: event.component,
      event: event.event,
      ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
      ...(event.subjectRef !== undefined ? { subjectRef: event.subjectRef } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.result !== undefined ? { result: event.result } : {}),
      ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
      ...(scrubbed !== undefined ? { fields: scrubbed } : {}),
    });
  }
}

/** Collects records in memory. Used by tests to assert on what was emitted. */
export class MemoryLogSink implements LogSink {
  readonly records: Record<string, unknown>[] = [];
  write(record: Readonly<Record<string, unknown>>): void {
    this.records.push({ ...record });
  }
}
