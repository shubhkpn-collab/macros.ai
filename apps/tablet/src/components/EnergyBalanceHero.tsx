import React from 'react';
import { Text, View } from 'react-native';
import { color, space, type, type EnergyBalanceView } from '@macros/tablet-view-model';

/**
 * THE primary metric: current energy balance, not "calories remaining".
 *
 * Every number is rendered exactly as the view model supplies it. The only
 * transformation is a leading sign, which is presentation.
 */
export function EnergyBalanceHero({ energy }: { energy: EnergyBalanceView }): React.JSX.Element {
  const tone = energy.direction === 'surplus' ? color.surplus : color.deficit;
  const sign = energy.balanceKcal > 0 ? '+' : '';

  return (
    <View
      accessible
      accessibilityRole="summary"
      // Screen readers get the semantic sentence, not a bare signed integer.
      accessibilityLabel={energy.semantic}
      style={{ alignItems: 'center', paddingVertical: space.xl }}
    >
      <Text style={{
        color: energy.incomplete ? color.textSecondary : tone,
        fontSize: type.hero.size, fontWeight: '700',
        letterSpacing: type.hero.tracking,
      }}>
        {sign}{energy.balanceKcal}
      </Text>
      <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.sm }}>
        {energy.semantic}
      </Text>

      {energy.incomplete ? (
        // Never let an incomplete estimate look authoritative. Stated in words,
        // not signalled by colour alone.
        <Text style={{ color: color.warning, fontSize: type.caption.size, marginTop: space.sm }}>
          Estimate incomplete{energy.gaps.length > 0 ? ` — ${energy.gaps.join(', ')}` : ''}
        </Text>
      ) : null}

      {energy.projectionNote !== null ? (
        <Text style={{ color: color.textMuted, fontSize: type.caption.size, marginTop: space.xs }}>
          {energy.projectionNote}
        </Text>
      ) : null}
    </View>
  );
}
