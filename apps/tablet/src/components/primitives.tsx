import React from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { color, radius, space, touch, type } from '@macros/tablet-view-model';

/**
 * Primitives sized for a kitchen appliance: 72pt minimum targets, type legible
 * from two to four feet, and no hover-dependent affordances.
 */

export function Surface(
  { children, style, level = 'raised' }:
  { children: React.ReactNode; style?: ViewStyle; level?: 'base' | 'raised' | 'overlay' },
): React.JSX.Element {
  const background = level === 'base' ? color.surfaceBase
    : level === 'overlay' ? color.surfaceOverlay : color.surfaceRaised;
  return (
    <View style={[{ backgroundColor: background, borderRadius: radius.lg, padding: space.lg }, style]}>
      {children}
    </View>
  );
}

export function Label(
  { children, tone = 'secondary' }:
  { children: React.ReactNode; tone?: 'primary' | 'secondary' | 'muted' },
): React.JSX.Element {
  const c = tone === 'primary' ? color.textPrimary
    : tone === 'muted' ? color.textMuted : color.textSecondary;
  return (
    <Text style={{ color: c, fontSize: type.label.size, letterSpacing: type.label.tracking }}>
      {children}
    </Text>
  );
}

/**
 * The single dominant action of a screen.
 *
 * `accessibilityLabel` is required rather than optional: an unlabelled primary
 * action is unusable with a screen reader, and making it optional guarantees
 * some screen eventually ships without one.
 */
export function PrimaryAction(
  { label, onPress, disabled = false, accessibilityLabel }:
  { label: string; onPress: () => void; disabled?: boolean; accessibilityLabel: string },
): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: touch.primaryHeight,
        borderRadius: radius.md,
        backgroundColor: disabled ? color.surfaceHairline
          : pressed ? color.accentPressed : color.accent,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.xl,
      })}
    >
      <Text style={{
        color: disabled ? color.textMuted : color.onAccent,
        fontSize: type.title.size, fontWeight: '600',
      }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SecondaryAction(
  { label, onPress, accessibilityLabel }:
  { label: string; onPress: () => void; accessibilityLabel: string },
): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: touch.minTarget,
        borderRadius: radius.md,
        borderWidth: 2,
        borderColor: pressed ? color.textSecondary : color.surfaceHairline,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.lg,
      })}
    >
      <Text style={{ color: color.textPrimary, fontSize: type.body.size }}>{label}</Text>
    </Pressable>
  );
}
