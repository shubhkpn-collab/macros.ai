import React from 'react';
import { Text, View } from 'react-native';
import { color, space, type, type ScaleView } from '@macros/tablet-view-model';

/**
 * Live weight.
 *
 * Unstable readings are shown but visibly provisional, and `canCommitWeight`
 * — decided by the view model from the settled candidate — is the only thing
 * that lets the weight be used.
 */
export function ScaleWeightDisplay(
  { scale, foodName }: { scale: ScaleView; foodName: string },
): React.JSX.Element {
  const settled = scale.canCommitWeight;

  return (
    <View accessible accessibilityLabel={
      scale.displayGrams === null
        ? `${foodName}. ${scale.message}`
        : `${foodName}. ${scale.displayGrams} grams. ${settled ? 'Stable' : 'Stabilising'}`
    } style={{ alignItems: 'center', paddingVertical: space.xl }}>
      <Text style={{ color: color.textSecondary, fontSize: type.title.size }}>{foodName}</Text>

      <Text style={{
        // Provisional weight is dimmed AND labelled: never colour alone.
        color: settled ? color.textPrimary : color.textSecondary,
        fontSize: type.hero.size, fontWeight: '700', marginTop: space.md,
      }}>
        {scale.displayGrams === null ? '—' : `${scale.displayGrams} g`}
      </Text>

      <Text style={{
        color: settled ? color.accent : color.textMuted,
        fontSize: type.body.size, marginTop: space.sm,
      }}>
        {settled ? 'Stable' : scale.message}
      </Text>
    </View>
  );
}
