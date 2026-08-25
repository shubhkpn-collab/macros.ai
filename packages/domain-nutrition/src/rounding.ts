/**
 * Centralised rounding. Full precision internally; rounding happens only at
 * display, so the sum of displayed macros never contradicts displayed calories.
 */
export function roundHalfUp(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** decimals;
  // Epsilon nudge avoids binary-representation ties (e.g. 1.005 -> 1.00).
  const scaled = value * f;
  const nudged = scaled >= 0 ? scaled + Number.EPSILON * Math.abs(scaled) : scaled - Number.EPSILON * Math.abs(scaled);
  return (value >= 0 ? Math.round(nudged) : -Math.round(-nudged)) / f;
}

export const displayKcal = (v: number): number => roundHalfUp(v, 0);
export const displayGrams = (v: number): number => roundHalfUp(v, 1);
