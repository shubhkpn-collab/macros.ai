import React from 'react';
import { Text, View } from 'react-native';
import { color, radius, space, type, type MacroView } from '@macros/tablet-view-model';

/** Consumed / goal / remaining — all three supplied, none computed here. */
export function MacroProgress({ macro }: { macro: MacroView }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={
        `${macro.label}: ${macro.consumedG} of ${macro.goalG} grams, ${macro.remainingG} remaining`
      }
      style={{ flex: 1, marginHorizontal: space.sm }}
    >
      <Text style={{ color: color.textSecondary, fontSize: type.label.size }}>{macro.label}</Text>
      <Text style={{ color: color.textPrimary, fontSize: type.display.size, fontWeight: '600' }}>
        {macro.consumedG}
        <Text style={{ color: color.textMuted, fontSize: type.body.size }}> / {macro.goalG} g</Text>
      </Text>

      <View style={{
        height: 12, borderRadius: radius.pill,
        backgroundColor: color.surfaceHairline, marginTop: space.sm, overflow: 'hidden',
      }}>
        <View style={{
          // Layout geometry only, already clamped by the view model.
          width: `${(macro.fraction ?? 0) * 100}%`,
          height: '100%', backgroundColor: color.accent,
        }} />
      </View>

      <Text style={{ color: color.textMuted, fontSize: type.caption.size, marginTop: space.xs }}>
        {macro.remainingG} g left
      </Text>
    </View>
  );
}
