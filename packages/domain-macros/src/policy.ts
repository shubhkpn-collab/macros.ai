import type { GuardrailPolicy, MacroPolicy } from '@macros/contracts';

/**
 * Macro distribution policy. Protein and fat are floors; carbohydrate is the
 * remainder. Values are product judgement, not physiology, but they still
 * require dietitian review before ship.
 */
export const DEFAULT_MACRO_POLICY: MacroPolicy = {
  version: 'macro@1.0.0',
  provenance: 'APPROVED_PRODUCTION',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  proteinGPerKg: 1.8,
  fatGPerKgFloor: 0.6,
  fatMinFractionOfKcal: 0.2,
};

/**
 * Safety guardrails. Enforced in the engine, never only in the UI, so no client
 * can request a target below the floor.
 */
export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  version: 'guardrail@1.0.0',
  provenance: 'APPROVED_PRODUCTION',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  absoluteFloorKcal: { male: 1500, female: 1200 },
  bmrFloorFraction: 0.7,
  maxDeficitKcal: 1000,
  maxSurplusKcal: 700,
};
