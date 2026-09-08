import React from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import {
  color, elevation, opacity, radius, space, touch, type,
} from '@macros/tablet-view-model';

/**
 * Appliance primitives.
 *
 * Sized for a 13.3" panel read from two to four feet: 72dp minimum targets,
 * generous padding, soft depth. Nothing here should read as a mobile control.
 */

export function Surface(
  { children, style, tone = 'surface' }:
  { children: React.ReactNode; style?: ViewStyle; tone?: 'surface' | 'muted' | 'hero' },
): React.JSX.Element {
  const background = tone === 'muted' ? color.surfaceMuted : color.surface;
  return (
    <View style={[{
      backgroundColor: background,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: color.border,
      padding: space.lg,
      ...(tone === 'hero' ? elevation.hero : elevation.raised),
    }, style]}>
      {children}
    </View>
  );
}

/** Small uppercase label above a block. Structure without shouting. */
export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Text style={{
      color: color.textMuted,
      fontSize: type.sectionLabel.size,
      fontWeight: type.sectionLabel.weight,
      letterSpacing: type.sectionLabel.tracking,
      textTransform: 'uppercase',
    }}>
      {children}
    </Text>
  );
}

/**
 * The single dominant action of a screen.
 *
 * `accessibilityLabel` is required rather than optional — an unlabelled primary
 * action is unusable with a screen reader, and optional guarantees some screen
 * eventually ships without one. The disabled state stays deliberate rather than
 * greyed into invisibility.
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
        borderRadius: radius.pill,
        backgroundColor: disabled ? color.surfaceDisabled
          : pressed ? color.accentPressed : color.accent,
        borderWidth: disabled ? 1 : 0,
        borderColor: color.border,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.xxl,
        opacity: disabled ? opacity.disabled : 1,
        ...(disabled ? elevation.flat : elevation.raised),
      })}
    >
      <Text style={{
        color: disabled ? color.textDisabled : color.onAccent,
        fontSize: type.button.size,
        fontWeight: type.button.weight,
        letterSpacing: type.button.tracking,
      }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SecondaryAction(
  { label, onPress, accessibilityLabel, tone = 'default', disabled = false }:
  {
    label: string; onPress: () => void; accessibilityLabel: string;
    tone?: 'default' | 'quiet';
    /** Manual weight entry needs this: an unparseable value must not submit. */
    disabled?: boolean;
  },
): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: disabled ? 0.45 : 1,
        minHeight: touch.secondaryHeight,
        borderRadius: radius.pill,
        borderWidth: tone === 'quiet' ? 0 : 1,
        borderColor: pressed ? color.borderStrong : color.border,
        backgroundColor: pressed ? color.surfaceActive : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.xl,
      })}
    >
      <Text style={{
        color: tone === 'quiet' ? color.textMuted : color.textSecondary,
        fontSize: type.body.size,
        fontWeight: '500',
      }}>
        {label}
      </Text>
    </Pressable>
  );
}
