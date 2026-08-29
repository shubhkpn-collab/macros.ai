import React from 'react';
import { Text, View } from 'react-native';
import { color, radius, space, type, type ScaleView } from '@macros/tablet-view-model';

/**
 * The signature weighing readout.
 *
 * A provisional reading is shown but visibly unsettled, and `canCommitWeight`
 * — decided by the view model from the settled candidate — is the only thing
 * that permits it to be used. Status is carried in words as well as colour.
 */
export function ScaleWeightDisplay({ scale }: { scale: ScaleView }): React.JSX.Element {
  const settled = scale.canCommitWeight;
  const statusCopy = settled ? 'Stable'
    : !scale.connected ? 'Scale not connected'
    : scale.message;

  return (
    <View
      accessible
      accessibilityLabel={
        scale.displayWeight === null
          ? statusCopy
          : `${scale.displayWeight}. ${statusCopy}`
      }
      style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: space.xl }}
    >
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{
          // Provisional weight is dimmed AND labelled below: never colour alone.
          color: settled ? color.textPrimary : color.textSecondary,
          fontSize: type.energyHero.size,
          fontWeight: type.energyHero.weight,
          letterSpacing: type.energyHero.tracking,
        }}
      >
        {scale.displayWeight ?? '—'}
      </Text>

      <View style={{
        marginTop: space.lg,
        flexDirection: 'row', alignItems: 'center', gap: space.sm,
        paddingHorizontal: space.lg, paddingVertical: space.sm,
        borderRadius: radius.pill,
        backgroundColor: color.surfaceMuted,
        borderWidth: 1,
        borderColor: settled ? color.accentMuted : color.border,
      }}>
        <View style={{
          width: 12, height: 12, borderRadius: radius.pill,
          backgroundColor: settled ? color.accent
            : scale.connected ? color.textMuted : color.offline,
        }} />
        <Text style={{
          color: settled ? color.accent : color.textSecondary,
          fontSize: type.body.size,
        }}>
          {statusCopy}
        </Text>
      </View>
    </View>
  );
}
