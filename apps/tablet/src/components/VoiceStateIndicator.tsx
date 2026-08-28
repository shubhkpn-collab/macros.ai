import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Text, View } from 'react-native';
import { color, motion, radius, space, type, type VoicePresence } from '@macros/tablet-view-model';

/**
 * A restrained voice "aura" rather than a chat transcript.
 *
 * The product is a calculator with a personality, not a chatbot: a scrolling
 * conversation would dominate a screen whose job is to show one number clearly.
 */
const COPY: Record<VoicePresence, string> = {
  idle: 'Say "Hey Macros"',
  listening: 'Listening',
  interpreting: 'Thinking',
  needs_choice: 'Which one?',
  waiting_for_weight: 'Place it on the scale',
  review: 'Ready to log',
  logging: 'Logging',
  completed: 'Logged',
  refused: 'Sorry — try again',
  offline: 'Voice unavailable offline',
};

export function VoiceStateIndicator({ presence }: { presence: VoicePresence }): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;
  const active = presence === 'listening' || presence === 'interpreting';

  useEffect(() => {
    let cancelled = false;
    // Respect reduced motion: a pulsing element is exactly what that setting is
    // for, so the state is carried by text regardless.
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced || !active) { pulse.setValue(0); return; }
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: motion.voicePulse / 2, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: motion.voicePulse / 2, useNativeDriver: true }),
      ])).start();
    });
    return () => { cancelled = true; };
  }, [active, pulse]);

  const dot = presence === 'offline' ? color.offline
    : presence === 'refused' ? color.danger
    : active ? color.accent : color.textMuted;

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Voice: ${COPY[presence]}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
    >
      <Animated.View style={{
        width: 16, height: 16, borderRadius: radius.pill, backgroundColor: dot,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
      }} />
      <Text style={{ color: color.textSecondary, fontSize: type.label.size }}>
        {COPY[presence]}
      </Text>
    </View>
  );
}
