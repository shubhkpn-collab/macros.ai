/**
 * Tiny deterministic property-testing helper.
 *
 * Seeded so a failure is always reproducible; no external dependency, and no
 * Math.random anywhere in the codebase.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PropertyOptions {
  readonly runs?: number;
  readonly seed?: number;
}

export function forAll<T>(
  generate: (rnd: () => number) => T,
  predicate: (value: T) => void,
  opts: PropertyOptions = {},
): void {
  const runs = opts.runs ?? 200;
  const seed = opts.seed ?? 0x5eed;
  for (let i = 0; i < runs; i++) {
    const rnd = mulberry32(seed + i);
    const value = generate(rnd);
    try {
      predicate(value);
    } catch (e) {
      const detail = JSON.stringify(value, null, 2);
      throw new Error(
        `Property failed on run ${i} (seed ${seed + i}) with input:\n${detail}\n\n${String(e)}`,
      );
    }
  }
}

export const between = (rnd: () => number, min: number, max: number): number =>
  min + rnd() * (max - min);

export const intBetween = (rnd: () => number, min: number, max: number): number =>
  Math.floor(between(rnd, min, max + 1));

export const pick = <T>(rnd: () => number, options: readonly T[]): T => {
  const item = options[Math.min(options.length - 1, Math.floor(rnd() * options.length))];
  if (item === undefined) throw new Error('pick: empty options');
  return item;
};

export const approx = (a: number, b: number, tolerance = 1e-9): boolean =>
  Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
