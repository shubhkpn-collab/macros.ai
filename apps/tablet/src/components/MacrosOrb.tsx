import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from 'react-native';
import { color, space, type } from '@macros/tablet-view-model';
import { SEGMENT_COUNT, segmentAngle, segmentHeights } from '@macros/tablet-voice';

/**
 * THE ORB — the appliance's one interaction surface.
 *
 * Per the approved reference this is a PRISMATIC RING: concentric haloes in
 * cool spectrum hues around an almost-empty centre, not a bordered circle. The
 * number floats inside with nothing enclosing it.
 *
 * Every speech state is expressed here. There are deliberately no play, pause,
 * waveform or speaker controls anywhere in the product — an appliance that
 * grows a media player stops feeling like an appliance, and the reference has
 * none. Only glow intensity and motion distinguish the states.
 */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'weighing';

export interface MacrosOrbProps {
  readonly state: OrbState;
  /** Large trusted grams, already formatted. Never computed here. */
  readonly weightLabel?: string;
  /** Unit shown small beneath the number, as in the reference. */
  readonly weightUnit?: string;
  readonly caption?: string;
  /** Smoothed microphone amplitude, 0–1. Drives the listening waveform only. */
  readonly level?: number;
  /** Changes when the wake phrase is heard, triggering one brief brightening. */
  readonly wakePulse?: number;
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
}

const DIAMETER = 300;

/** Resting halo strength per state. Motion carries the rest. */
const INTENSITY: Record<OrbState, number> = {
  idle: 0.22,
  listening: 0.55,
  thinking: 0.34,
  speaking: 0.46,
  weighing: 0.5,
};

export function MacrosOrb({
  state, weightLabel, weightUnit, caption, level = 0, wakePulse = 0, onPress,
  accessibilityLabel, disabled = false,
}: MacrosOrbProps): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;
  /** One short brightening when "Hey Macros" is recognised. */
  const wake = useRef(new Animated.Value(0)).current;
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
    // Someone who asked the system for less motion should not be given a
    // breathing light in their kitchen.
    if (!animated || reduceMotion.current) {
      pulse.setValue(0);
      return undefined;
    }
    // Thinking is slow and even; speaking breathes; listening is quicker and
    // more alert. Same component, same language, different tempo.
    const duration = state === 'thinking' ? 1500 : state === 'speaking' ? 1100 : 800;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, {
        toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
      }),
      Animated.timing(pulse, {
        toValue: 0, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
      }),
    ]));
    loop.start();
    return () => { loop.stop(); };
  }, [state, pulse]);

  useEffect(() => {
    if (wakePulse === 0) return undefined;
    // A single acknowledging beat, not a repeating animation — the appliance
    // nods once and keeps listening.
    const beat = Animated.sequence([
      Animated.timing(wake, {
        toValue: 1, duration: 180, easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(wake, {
        toValue: 0, duration: 420, easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    beat.start();
    return () => { beat.stop(); };
  }, [wakePulse, wake]);

  const base = INTENSITY[state];
  const glow = pulse.interpolate({
    inputRange: [0, 1], outputRange: [base, Math.min(base + 0.3, 0.85)],
  });
  const breathe = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });

  /** Concentric spectrum haloes, widest and softest on the outside. */
  const haloes: readonly { readonly size: number; readonly tint: string; readonly a: number }[] = [
    { size: DIAMETER + 120, tint: color.orbSpectrumD, a: 0.30 },
    { size: DIAMETER + 78, tint: color.orbSpectrumC, a: 0.45 },
    { size: DIAMETER + 44, tint: color.orbSpectrumB, a: 0.60 },
    { size: DIAMETER + 16, tint: color.orbSpectrumA, a: 0.85 },
  ];

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      {haloes.map((halo) => (
        <Animated.View
          key={halo.tint}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: halo.size, height: halo.size, borderRadius: halo.size / 2,
            borderWidth: 2, borderColor: halo.tint,
            // The wake beat brightens the existing haloes rather than adding a
            // new element, so the acknowledgement stays part of the same orb.
            opacity: Animated.multiply(
              Animated.add(glow, Animated.multiply(wake, 0.35)), halo.a),
            transform: [{ scale: breathe }],
          }}
        />
      ))}

      {/* The bright inner ring the number sits within. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: DIAMETER, height: DIAMETER, borderRadius: DIAMETER / 2,
          borderWidth: 3, borderColor: color.orbSpectrumA,
          opacity: glow, transform: [{ scale: breathe }],
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
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {state === 'listening' ? (
          /**
           * RADIAL WAVEFORM — luminous strokes arranged AROUND the centre,
           * each rotated into place and lengthened by real microphone
           * amplitude. Not a row of bars: a ring of light coming alive.
           *
           * Plain Views with rotation transforms, no SVG and no animation
           * library. Each level is drawn and dropped; nothing is stored.
           */
          <View
            style={{
              width: DIAMETER, height: DIAMETER,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            {segmentHeights(level).map((height, index) => (
              <View
                key={`stroke-${String(index)}`}
                style={{
                  position: 'absolute',
                  width: DIAMETER, height: DIAMETER,
                  alignItems: 'center',
                  transform: [{ rotate: `${String(segmentAngle(index))}deg` }],
                }}
              >
                <View
                  style={{
                    width: 5, borderRadius: 3,
                    // Grows inward from the ring, leaving the centre open.
                    height: Math.max(8, height * 74),
                    marginTop: 26,
                    backgroundColor: index % 2 === 0
                      ? color.orbSpectrumA : color.orbSpectrumC,
                    opacity: 0.4 + (height * 0.6),
                  }}
                />
              </View>
            ))}
          </View>
        ) : weightLabel !== undefined ? (
          <>
            <Text
              style={{
                color: color.textPrimary,
                fontSize: 88, fontWeight: '700', letterSpacing: -3,
              }}
            >
              {weightLabel}
            </Text>
            {weightUnit !== undefined ? (
              <Text style={{ color: color.textSecondary, fontSize: 22, marginTop: -6 }}>
                {weightUnit}
              </Text>
            ) : null}
          </>
        ) : caption !== undefined ? (
          <Text
            style={{
              color: state === 'idle' ? color.textSecondary : color.textPrimary,
              fontSize: type.body.size, letterSpacing: 1,
            }}
          >
            {caption}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

/**
 * A premium food card, per the reference: image panel on top, name beneath,
 * and a bright ring when selected.
 */
export function FoodCard({
  name, detail, selected = false, onPress, accessibilityLabel,
}: {
  readonly name: string;
  readonly detail?: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={{
        width: 210, minHeight: 236, borderRadius: 22,
        backgroundColor: color.surface,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? color.textPrimary : color.surfaceMuted,
        overflow: 'hidden', marginRight: space.md,
      }}
    >
      {/* Image panel. Present even with no photograph, so real product imagery
          drops in later without a second layout pass — and no external URL is
          invented in the meantime. */}
      <View
        style={{
          height: 132, margin: space.sm, borderRadius: 14,
          backgroundColor: color.surfaceMuted,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ color: color.textMuted, fontSize: 32, fontWeight: '600' }}>
          {name.slice(0, 1).toUpperCase()}
        </Text>
      </View>

      <View style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
        <Text
          numberOfLines={2}
          style={{ color: color.textPrimary, fontSize: 17, textAlign: 'center' }}
        >
          {name}
        </Text>
        {detail !== undefined && detail.length > 0 ? (
          <Text
            numberOfLines={1}
            style={{
              color: color.textMuted, fontSize: 14,
              textAlign: 'center', marginTop: space.xxs,
            }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Per-macro hue, so the three read apart at a glance. */
const MACRO_TINT: Readonly<Record<string, string>> = {
  Protein: color.macroProtein,
  Fat: color.macroFat,
  Carbs: color.macroCarbs,
  Calories: color.accent,
};

/**
 * Minimal circular macro indicator.
 *
 * Values arrive pre-formatted; nothing is computed here.
 */
export function MacroRing({
  label, value, size = 62,
}: {
  readonly label: string;
  readonly value?: string;
  readonly size?: number;
}): React.JSX.Element {
  const tint = MACRO_TINT[label] ?? color.neutral;
  return (
    <View style={{ alignItems: 'center', marginHorizontal: space.lg }}>
      <View
        style={{
          width: size, height: size, borderRadius: size / 2,
          borderWidth: 4, borderColor: tint,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {value !== undefined ? (
          <Text style={{ color: color.textPrimary, fontSize: 15, fontWeight: '600' }}>
            {value}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: color.textMuted, fontSize: 14, marginTop: space.sm }}>
        {label}
      </Text>
    </View>
  );
}
