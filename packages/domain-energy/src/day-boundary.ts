import type { DayBoundary, Instant } from '@macros/contracts';

/**
 * Elapsed fraction of the user's day. PURE: the instant is an argument, never
 * read from a clock. Uses the user's profile timezone (not the device's) so
 * travel does not produce a three-hour day.
 */
export function elapsedDayFraction(asOf: Instant, day: DayBoundary): number {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) throw new Error(`elapsedDayFraction: invalid instant ${asOf}`);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: day.timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  let hour = 0, minute = 0, second = 0;
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }

  const localSeconds = hour * 3600 + minute * 60 + second;
  const rolloverSeconds = day.rolloverHour * 3600;
  const elapsed = (localSeconds - rolloverSeconds + 86400) % 86400;
  return elapsed / 86400;
}
