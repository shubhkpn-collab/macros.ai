/**
 * Types for the plain-JS registration helper.
 *
 * The helper stays `.mjs` because `hydrate-android-shell.mjs` runs under plain
 * node, which cannot import TypeScript. Declaring the shape here keeps the
 * script runnable and the test type-checked.
 */
export declare const REGISTRATION: string;

export interface RegistrationResult {
  readonly ok: boolean;
  readonly changed?: boolean;
  readonly source?: string;
  readonly reason?: string;
}

export declare function countRegistrations(source: string): number;
export declare function registerSpeechPackage(source: string): RegistrationResult;
