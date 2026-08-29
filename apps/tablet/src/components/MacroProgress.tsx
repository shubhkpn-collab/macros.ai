import React from 'react';
import { Text, View } from 'react-native';
import { color, radius, space, type, type MacroView } from '@macros/tablet-view-model';

/**
 * One macro module: consumed / target, progress, remaining.
 *
 * All three figures arrive already formatted — the raw `48.333333333333336 g`
 * seen on the first real device run never reaches this component.
 */
export function MacroProgress({ macro }: { macro: MacroView }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={
        `${macro.label}: ${macro.displayConsumed} of ${macro.displayGoal} grams, `
        + `${macro.displayRemaining} grams remaining`
      }
      style={{
        flex: 1,
        backgroundColor: color.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: color.border,
        paddingVertical: space.lg,
        paddingHorizontal: space.md,
      }}
    >
      <Text style={{
        color: color.textMuted, fontSize: type.sectionLabel.size,
        fontWeight: type.sectionLabel.weight, letterSpacing: type.sectionLabel.tracking,
        textTransform: 'uppercase',
      }}>
        {macro.label}
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: space.sm }}>
        <Text style={{
          color: color.textPrimary, fontSize: type.macroMetric.size,
          fontWeight: type.macroMetric.weight, letterSpacing: type.macroMetric.tracking,
        }}>
          {macro.displayConsumed}
        </Text>
        <Text style={{ color: color.textMuted, fontSize: type.body.size }}>
          {' / '}{macro.displayGoal} g
        </Text>
      </View>

      <View style={{
        height: 10, borderRadius: radius.pill, backgroundColor: color.surfaceMuted,
        marginTop: space.md, overflow: 'hidden',
      }}>
        <View style={{
          // Layout geometry only, already clamped by the view model.
          width: `${(macro.fraction ?? 0) * 100}%`,
          height: '100%',
          backgroundColor: color.accent,
          borderRadius: radius.pill,
        }} />
      </View>

      <Text style={{ color: color.textSecondary, fontSize: type.caption.size, marginTop: space.sm }}>
        {macro.displayRemaining} g left
      </Text>
    </View>
  );
}
