/** Branded scalar types. Prevents mixing grams with kilocalories at compile time. */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Grams = Brand<number, 'Grams'>;
export type Millilitres = Brand<number, 'Millilitres'>;
export type Kcal = Brand<number, 'Kcal'>;
export type Kilograms = Brand<number, 'Kilograms'>;
export type Centimetres = Brand<number, 'Centimetres'>;
export type Years = Brand<number, 'Years'>;
export type Fraction = Brand<number, 'Fraction'>;

export const grams = (n: number): Grams => n as Grams;
export const millilitres = (n: number): Millilitres => n as Millilitres;
export const kcal = (n: number): Kcal => n as Kcal;
export const kilograms = (n: number): Kilograms => n as Kilograms;
export const centimetres = (n: number): Centimetres => n as Centimetres;
export const years = (n: number): Years => n as Years;
export const fraction = (n: number): Fraction => n as Fraction;

/** ISO-8601 instant. Time is always an argument — the domain never reads a clock. */
export type Instant = Brand<string, 'Instant'>;
export const instant = (iso: string): Instant => iso as Instant;

export type CalcVersion = Brand<string, 'CalcVersion'>;
export const calcVersion = (v: string): CalcVersion => v as CalcVersion;

export type Sex = 'male' | 'female';

/** Atwater energy factors, kcal per gram. Fixed physical constants. */
export const ATWATER = {
  protein: 4,
  carbohydrate: 4,
  fat: 9,
  alcohol: 7,
} as const;
