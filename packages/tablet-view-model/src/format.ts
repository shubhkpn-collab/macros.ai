/**
 * PRESENTATION FORMATTING.
 *
 * The first real Android run showed `-1822.1109375` and `48.333333333333336 g`
 * on screen. Those are correct domain values rendered without a presentation
 * layer — a food scale reads 200 g, not 199.99999999999997 g, and an appliance
 * that shows sixteen decimal places looks broken regardless of how right it is.
 *
 * Formatting lives HERE and nowhere else: not in the domain engines, whose
 * precision is deliberate and must not be rounded away, and not in React
 * components, which must never do arithmetic on nutrition. These functions take
 * an authoritative number and return a string. They never feed a number back
 * into a calculation.
 */
export const FORMAT_VERSION = 'tablet-format@1.0.0';

/** Thousands separators without pulling in Intl locale data. */
function groupThousands(whole: string): string {
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/**
 * Whole kcal with a thousands separator: `-1,505`, `+214`, `0`.
 *
 * A signed display is deliberate — the sign IS the meaning here, and dropping
 * it would turn a deficit and a surplus into the same number.
 */
export function formatKcal(value: number, options: { sign?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  // Math.round(-0.2) is -0, which renders as "-0". Normalise it away.
  const normalised = rounded === 0 ? 0 : rounded;
  const grouped = groupThousands(String(normalised));
  if (options.sign !== true || normalised <= 0) return grouped;
  return `+${grouped}`;
}

/**
 * Grams: whole when effectively whole, otherwise one decimal.
 *
 * `48.333333333333336` becomes `48.3`; `62.0000001` becomes `62`. The epsilon
 * matters because accumulated floating-point addition rarely lands exactly on
 * an integer even when the true value is one.
 */
export function formatGrams(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  const normalised = rounded === 0 ? 0 : rounded;
  if (Math.abs(normalised - Math.round(normalised)) < 0.05) {
    return groupThousands(String(Math.round(normalised)));
  }
  // Sign is handled explicitly: Math.trunc(-0.2) is -0, which stringifies to
  // "0" and would silently drop the minus.
  const sign = normalised < 0 ? '-' : '';
  const magnitude = Math.abs(normalised);
  const whole = groupThousands(String(Math.trunc(magnitude)));
  const tenth = Math.round(magnitude * 10) % 10;
  return `${sign}${whole}.${tenth}`;
}

/** Grams with the unit, for display in a single label. */
export const formatGramsWithUnit = (value: number): string => `${formatGrams(value)} g`;

/**
 * The semantic balance line.
 *
 * "Calories remaining" is deliberately absent: the product's north star is where
 * you stand right now, not how much budget is left.
 */
export function describeBalanceCopy(balanceKcal: number): string {
  if (!Number.isFinite(balanceKcal)) return 'Balance unavailable';
  const rounded = Math.round(balanceKcal);
  if (rounded === 0) return 'At maintenance right now';
  const magnitude = groupThousands(String(Math.abs(rounded)));
  return rounded < 0
    ? `${magnitude} kcal deficit right now`
    : `${magnitude} kcal surplus right now`;
}

/** Subordinate projection line. */
export function formatProjection(ifNoMoreFoodKcal: number): string {
  return `If no more food: ${formatKcal(ifNoMoreFoodKcal, { sign: true })} kcal`;
}

/**
 * Progress fraction for a bar width, clamped to 0..1.
 *
 * Clamping is LAYOUT ONLY — the authoritative consumed and target values are
 * untouched, so an overshoot still reads honestly in the numbers beside the bar
 * even though the bar itself cannot draw past its track.
 */
export function progressFraction(consumed: number, target: number): number | null {
  if (!Number.isFinite(consumed) || !Number.isFinite(target) || target <= 0) return null;
  return Math.min(1, Math.max(0, consumed / target));
}
