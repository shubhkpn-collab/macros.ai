import type { Instant } from '@macros/contracts';

/**
 * EVENT-LOCAL TIME PROVENANCE.
 *
 * A UTC instant alone cannot tell you which local calendar day a meal belonged
 * to once DST is involved, so every log stores the instant, the IANA timezone,
 * and the UTC offset in force at that moment.
 *
 * PURE: the instant is always an argument. No clock is read.
 */
export interface LocalDayInfo {
  readonly localDate: string;
  readonly utcOffsetMinutes: number;
  readonly timezone: string;
}

const partsOf = (ms: number, timezone: string): Record<string, string> => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
};

/** Offset in force at this instant in this zone, in minutes east of UTC. */
export function utcOffsetMinutes(at: Instant, timezone: string): number {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`utcOffsetMinutes: invalid instant ${at}`);
  const p = partsOf(ms, timezone);
  const asUtc = Date.UTC(
    Number(p['year']), Number(p['month']) - 1, Number(p['day']),
    Number(p['hour']), Number(p['minute']), Number(p['second']),
  );
  return Math.round((asUtc - ms) / 60000);
}

/**
 * The user's local calendar day for an event.
 *
 * `rolloverHour` defaults to 0 — midnight, the ordinary calendar day. It is
 * never silently set to anything else.
 */
export function localDayOf(at: Instant, timezone: string, rolloverHour = 0): LocalDayInfo {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`localDayOf: invalid instant ${at}`);
  const offset = utcOffsetMinutes(at, timezone);

  const shifted = rolloverHour === 0 ? ms : ms - rolloverHour * 3600_000;
  const p = partsOf(shifted, timezone);
  const localDate = `${p['year']}-${p['month']}-${p['day']}`;

  return { localDate, utcOffsetMinutes: offset, timezone };
}
