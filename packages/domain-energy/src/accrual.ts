import type { TefAccrualPolicy } from '@macros/contracts';

export const TEF_ACCRUAL_V1: TefAccrualPolicy = {
  version: 'tef-accrual@1.0.0-zero',
  kind: 'zero_accrued',
};

/**
 * How much of today's estimated TEF counts as already expended right now.
 *
 * v1 returns 0. This is NOT a claim that real TEF is zero. It states that
 * MACROS.AI does not yet claim to know how much of today's estimated TEF has
 * already occurred at this instant. Counting a meal's full thermic cost the
 * moment it is logged would be false precision that flatters the live balance.
 *
 * An evidence-reviewed intra-day thermogenesis curve is a later versioned
 * upgrade requiring no engine change.
 */
export function accruedTefKcal(policy: TefAccrualPolicy, estimatedTotalKcal: number): number {
  switch (policy.kind) {
    case 'zero_accrued':
      return 0;
    case 'intraday_curve':
      throw new Error(
        'TefAccrualPolicy "intraday_curve" is reserved and not implemented: ' +
          'it requires an evidence-reviewed digestion model.',
      );
  }
}
