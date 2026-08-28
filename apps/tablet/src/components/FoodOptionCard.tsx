import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  color, radius, space, touch, type, type FoodOptionView,
} from '@macros/tablet-view-model';

/**
 * One candidate food.
 *
 * `optionLabel` comes straight from orchestration, so the "B" a person says
 * and the "B" they see are the same B by construction.
 */
export function FoodOptionCard(
  { option, onSelect }: { option: FoodOptionView; onSelect: (id: string) => void },
): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        `Option ${option.optionLabel}. ${option.displayName}. ${option.preparationState}`
      }
      onPress={() => onSelect(option.productVersionId)}
      style={({ pressed }) => ({
        minHeight: touch.cardMinHeight,
        borderRadius: radius.lg,
        backgroundColor: pressed ? color.surfaceOverlay : color.surfaceRaised,
        padding: space.lg,
        marginBottom: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.lg,
      })}
    >
      <View style={{
        width: touch.minTarget, height: touch.minTarget, borderRadius: radius.md,
        backgroundColor: color.surfaceOverlay, alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{ color: color.accent, fontSize: type.title.size, fontWeight: '700' }}>
          {option.optionLabel}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text style={{ color: color.textPrimary, fontSize: type.title.size }} numberOfLines={2}>
          {option.displayName}
        </Text>
        {option.brand !== null ? (
          <Text style={{ color: color.textSecondary, fontSize: type.body.size }}>
            {option.brand}
          </Text>
        ) : null}
        <Text style={{
          // When preparation is what separates two candidates, say so loudly:
          // raw and cooked differ enough to matter.
          color: option.preparationMatters ? color.warning : color.textMuted,
          fontSize: type.caption.size, marginTop: space.xs,
        }}>
          {option.preparationState}{option.preparationMatters ? ' · check preparation' : ''}
        </Text>
      </View>
    </Pressable>
  );
}
