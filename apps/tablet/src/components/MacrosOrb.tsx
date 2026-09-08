import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from 'react-native';
import { color, space, type } from '@macros/tablet-view-model';

/**
 * THE ORB — the appliance's primary control.
 *
 * One element carries the whole interaction: tap to speak, watch it think,
 * read the weight off it. That is what makes this feel like a device rather
 * than a dashboard, so the states live in one component instead of being
 * scattered across screens.
 *
 * The glow is restrained on purpose. A kitchen appliance that pulses like a
 * games console reads as a toy, and this has to look like it costs $400.
 */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'weighing';

export interface MacrosOrbProps {
  readonly state: OrbState;
  /** Large trusted grams, already formatted. Never computed here. */
  readonly weightLabel?: string;
  readonly caption: string;
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
}

const DIAMETER = 300;

const RING_FOR: Record<OrbState, string> = {
  idle: color.accentMuted,
  listening: color.accent,
  thinking: color.accentMuted,
  speaking: color.accent,
  weighing: color.accent,
};

export function MacrosOrb({
  state, weightLabel, caption, onPress, accessibilityLabel, disabled = false,
}: MacrosOrbProps): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;
  const reduceMotion = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) reduceMotion.current = enabled;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const animated = state === 'listening' || state === 'thinking' || state === 'speaking';
    // Someone who has asked the system for less motion should not be given a
    // breathing light in their kitchen.
    if (!animated || reduceMotion.current) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, {
        toValue: 1, duration: state === 'thinking' ? 1400 : 900,
        easing: Easing.inOut(Easing.quad), useNativeDriver: true,
      }),
      Animated.timing(pulse, {
        toValue: 0, duration: state === 'thinking' ? 1400 : 900,
        easing: Easing.inOut(Easing.quad), useNativeDriver: true,
      }),
    ]));
    loop.start();
    return () => { loop.stop(); };
  }, [state, pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.42] });

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* Halo. Separate from the ring so the glow can breathe without the
          border thickness appearing to change. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: DIAMETER + 80, height: DIAMETER + 80,
          borderRadius: (DIAMETER + 80) / 2,
          backgroundColor: color.accent,
          opacity: state === 'idle' ? 0.08 : haloOpacity,
          transform: [{ scale }],
        }}
      />

      <Pressable
        onPress={onPress}
        disabled={disabled || onPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ busy: state === 'thinking', disabled }}
        style={{
          width: DIAMETER, height: DIAMETER, borderRadius: DIAMETER / 2,
          borderWidth: 2, borderColor: RING_FOR[state],
          backgroundColor: color.surface,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {state === 'weighing' && weightLabel !== undefined ? (
          <Text
            style={{
              color: color.textPrimary,
              fontSize: 84, fontWeight: '700', letterSpacing: -3,
            }}
          >
            {weightLabel}
          </Text>
        ) : (
          <Text
            style={{
              color: state === 'idle' ? color.textSecondary : color.accent,
              fontSize: type.body.size, letterSpacing: 1,
            }}
          >
            {caption}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * A premium food card.
 *
 * The image area is deliberately present even with no image: dropping real
 * product photography in later must not require a second layout pass.
 */
export function FoodCard({
  name, detail, onPress, accessibilityLabel,
}: {
  readonly name: string;
  readonly detail?: string;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: 260, minHeight: 232, borderRadius: 24,
        backgroundColor: color.surface,
        borderWidth: 1, borderColor: color.surfaceMuted,
        overflow: 'hidden', marginRight: space.md,
      }}
    >
      {/* Placeholder image area. Deliberate, not a broken URL: an invented
          photograph would misrepresent the catalog. */}
      <View
        style={{
          height: 130, backgroundColor: color.surfaceMuted,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ color: color.textMuted, fontSize: 34, fontWeight: '600' }}>
          {name.slice(0, 1).toUpperCase()}
        </Text>
      </View>

      <View style={{ padding: space.md }}>
        <Text numberOfLines={2} style={{ color: color.textPrimary, fontSize: 19 }}>
          {name}
        </Text>
        {detail !== undefined && detail.length > 0 ? (
          <Text style={{ color: color.textMuted, fontSize: 15, marginTop: space.xs }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Minimal macro indicator. Values are pre-formatted upstream. */
export function MacroRing({
  label, value,
}: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <View style={{ alignItems: 'center', marginHorizontal: space.lg }}>
      <View
        style={{
          width: 92, height: 92, borderRadius: 46,
          borderWidth: 2, borderColor: color.accentMuted,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ color: color.textPrimary, fontSize: 22, fontWeight: '600' }}>
          {value}
        </Text>
      </View>
      <Text style={{ color: color.textMuted, fontSize: 14, marginTop: space.sm }}>
        {label}
      </Text>
    </View>
  );
}
