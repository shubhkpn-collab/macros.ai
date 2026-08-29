import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  color, radius, space, touch, type, type FoodOptionView,
} from '@macros/tablet-view-model';

/**
 * One candidate food.
 *
 * `optionLabel` comes straight from orchestration, so the "B" a person says and
 * the "B" they see are the same B by construction. Preparation state is given
 * real prominence: raw and cooked chicken differ by roughly a third in energy,
 * and quietly picking the wrong one is the single most damaging mistake this
 * screen could make.
 */
export function FoodOptionCard(
  { option, onSelect }: { option: FoodOptionView; onSelect: (id: string) => void },
): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        `Option ${option.optionLabel}. ${option.displayName}. `
        + `${option.brand !== null ? `${option.brand}. ` : ''}${option.preparationState}`
      }
      onPress={() => onSelect(option.productVersionId)}
      style={({ pressed }) => ({
        minHeight: touch.cardMinHeight,
        borderRadius: radius.lg,
        backgroundColor: pressed ? color.surfaceActive : color.surface,
        borderWidth: 1,
        borderColor: pressed ? color.accent : color.border,
        paddingVertical: space.lg,
        paddingHorizontal: space.lg,
        marginBottom: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.lg,
      })}
    >
      <View style={{
        width: touch.minTarget, height: touch.minTarget, borderRadius: radius.md,
        backgroundColor: color.surfaceMuted, borderWidth: 1, borderColor: color.border,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{
          color: color.accent, fontSize: type.metric.size, fontWeight: '700',
        }}>
          {option.optionLabel}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={2}
          style={{ color: color.textPrimary, fontSize: type.metric.size, fontWeight: '600' }}
        >
          {option.displayName}
        </Text>

        {option.brand !== null ? (
          <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.xxs }}>
            {option.brand}
          </Text>
        ) : null}

        <View style={{
          alignSelf: 'flex-start', marginTop: space.sm,
          paddingHorizontal: space.md, paddingVertical: space.xxs,
          borderRadius: radius.pill,
          backgroundColor: option.preparationMatters ? 'transparent' : color.surfaceMuted,
          borderWidth: 1,
          borderColor: option.preparationMatters ? color.warning : color.border,
        }}>
          <Text style={{
            color: option.preparationMatters ? color.warning : color.textSecondary,
            fontSize: type.caption.size,
          }}>
            {option.preparationState}
            {option.preparationMatters ? ' · check preparation' : ''}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
