import React from 'react';
import { Text, View } from 'react-native';
import { color, space, type, type EnergyBalanceView } from '@macros/tablet-view-model';

/**
 * THE NORTH STAR: current energy balance, not "calories remaining".
 *
 * Every value arrives display-ready from the view model. The renderer prints
 * strings — it does not round, scale or sign anything, because a number that
 * disagrees with the food log would be invisible until someone noticed their
 * day did not add up.
 */
export function EnergyBalanceHero({ energy }: { energy: EnergyBalanceView }): React.JSX.Element {
  const tone = energy.incomplete ? color.textSecondary
    : energy.direction === 'surplus' ? color.surplus
    : energy.direction === 'deficit' ? color.deficit
    : color.neutral;

  return (
    <View
      accessible
      accessibilityRole="summary"
      // A screen reader gets the sentence, not a bare signed integer.
      accessibilityLabel={energy.semantic}
      style={{ alignItems: 'center', paddingVertical: space.xl }}
    >
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{
          color: tone,
          fontSize: type.energyHero.size,
          fontWeight: type.energyHero.weight,
          letterSpacing: type.energyHero.tracking,
          lineHeight: type.energyHero.size * 1.04,
        }}
      >
        {energy.displayValue}
      </Text>

      <Text style={{
        color: color.textMuted, fontSize: type.sectionLabel.size,
        letterSpacing: type.sectionLabel.tracking, marginTop: -space.xs,
      }}>
        KCAL
      </Text>

      <Text style={{
        color: color.textSecondary, fontSize: type.body.size, marginTop: space.md,
      }}>
        {energy.semantic}
      </Text>

      {energy.incomplete ? (
        // Never let an incomplete estimate look authoritative — and say so in
        // words, so the warning does not depend on noticing a colour.
        <View style={{
          marginTop: space.md, paddingHorizontal: space.md, paddingVertical: space.xs,
          borderRadius: 999, borderWidth: 1, borderColor: color.warning,
        }}>
          <Text style={{ color: color.warning, fontSize: type.caption.size }}>
            Estimate incomplete{energy.gaps.length > 0 ? ` · ${energy.gaps.join(', ')}` : ''}
          </Text>
        </View>
      ) : null}

      {energy.projectionNote !== null ? (
        <Text style={{
          color: color.textMuted, fontSize: type.caption.size, marginTop: space.sm,
        }}>
          {energy.projectionNote}
        </Text>
      ) : null}
    </View>
  );
}
