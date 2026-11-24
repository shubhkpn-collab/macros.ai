import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  color,
  motion,
  radius,
  space,
  type,
  type TabletViewModel,
} from '@macros/tablet-view-model';
import type { ScreenActions } from './screens.js';
import {
  FoodOptionsScreen,
  FoodSearchScreen,
  LoggedScreen,
  ReviewScreen,
  WeighingScreen,
} from './screens.js';
import { DashboardScreen, GoalSheet } from './DashboardScreen.js';
import { FoodCard, MacrosOrb, type OrbState } from './MacrosOrb.js';
import { GlassSheen, Icon, KitchenAtmosphere } from './ReferenceKit.js';
import { DevelopmentBanner, OfflineStatus } from './status.js';

export const KITCHEN_OS_VERSION = 'kitchenos@1.0.0';

type HomePage = 'home' | 'dashboard';

function voiceOrbState(vm: TabletViewModel, actions: ScreenActions): OrbState {
  if (actions.conversationActive === true) {
    if (actions.conversationPhase === 'speaking') return 'speaking';
    if (actions.conversationPhase === 'thinking' || actions.conversationPhase === 'connecting') return 'thinking';
    return 'listening';
  }
  if (actions.isListening === true) return 'listening';
  if (vm.guidance.phase === 'thinking') return 'thinking';
  if (actions.isSpeaking === true) return 'speaking';
  return 'idle';
}

function voiceCopy(state: OrbState): string {
  if (state === 'listening') return 'Listening';
  if (state === 'thinking') return 'Thinking';
  if (state === 'speaking') return 'Speaking';
  return 'Ready';
}

function ScreenTransition(
  { transitionKey, children }: { transitionKey: string; children: React.ReactNode },
): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) {
        opacity.setValue(1);
        translate.setValue(0);
        return;
      }
      opacity.setValue(0);
      translate.setValue(10);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: motion.normal,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translate, {
          toValue: 0,
          duration: motion.normal,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    });
    return () => { cancelled = true; };
  }, [transitionKey, opacity, translate]);

  return (
    <Animated.View style={{ flex: 1, opacity, transform: [{ translateY: translate }] }}>
      {children}
    </Animated.View>
  );
}

function ProfileChip(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element | null {
  if (vm.identity === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Active profile ${vm.identity.displayName}. Double tap to switch member.`}
      onPress={actions.onSelectMember}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: pressed ? color.surfaceActive : color.surface,
        borderWidth: 1,
        borderColor: color.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      })}
    >
      <View style={{
        width: 34,
        height: 34,
        borderRadius: radius.pill,
        backgroundColor: color.surfaceMuted,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Icon name="user" size={18} tint={color.textPrimary} />
      </View>
      <View>
        <Text style={{ color: color.textMuted, fontSize: 11, letterSpacing: 0.8 }}>ACTIVE</Text>
        <Text style={{ color: color.textPrimary, fontSize: 16, fontWeight: '600', marginTop: 1 }}>
          {vm.identity.displayName}
        </Text>
      </View>
    </Pressable>
  );
}

function VoiceChip(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const state = voiceOrbState(vm, actions);
  const onPress = actions.onConversation ?? actions.onOrbPress ?? actions.onRequestGuidance;
  const active = state !== 'idle';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? `${voiceCopy(state)}. Tap to stop or speak.` : 'Talk to Macros'}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: pressed ? color.surfaceActive : color.surface,
        borderWidth: 1,
        borderColor: active ? color.orbSpectrumA : color.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      })}
    >
      <View style={{
        width: 34,
        height: 34,
        borderRadius: radius.pill,
        backgroundColor: active ? color.surfaceActive : color.surfaceMuted,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Icon name="mic" size={18} tint={active ? color.orbSpectrumA : color.textPrimary} />
      </View>
      <Text style={{ color: active ? color.textPrimary : color.textSecondary, fontSize: 15, fontWeight: '600' }}>
        {voiceCopy(state)}
      </Text>
    </Pressable>
  );
}

function Wordmark(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel="Hey Macros">
      <Text style={{
        color: color.textPrimary,
        fontSize: 25,
        fontWeight: '700',
        letterSpacing: -0.8,
      }}>
        Hey! Macros
      </Text>
      <Text style={{ color: color.textMuted, fontSize: 11, letterSpacing: 2.2, textAlign: 'center', marginTop: 2 }}>
        KITCHENOS
      </Text>
    </View>
  );
}

function Header(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  return (
    <View style={{
      minHeight: 84,
      paddingHorizontal: space.xl,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}>
      <ProfileChip vm={vm} actions={actions} />
      <Wordmark />
      <VoiceChip vm={vm} actions={actions} />
    </View>
  );
}

function MacroStrip({ vm }: { vm: TabletViewModel }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
      {vm.macros.map((macro) => (
        <View
          key={macro.label}
          accessible
          accessibilityLabel={`${macro.label}, ${macro.displayConsumed} of ${macro.displayGoal} grams`}
          style={{
            flex: 1,
            minHeight: 92,
            borderRadius: radius.lg,
            backgroundColor: color.surfaceMuted,
            borderWidth: 1,
            borderColor: color.border,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: color.textMuted, fontSize: 12, letterSpacing: 0.7, textTransform: 'uppercase' }}>
            {macro.label}
          </Text>
          <Text style={{ color: color.textPrimary, fontSize: 23, fontWeight: '600', marginTop: 5 }}>
            {macro.displayConsumed}
            <Text style={{ color: color.textMuted, fontSize: 14, fontWeight: '400' }}> / {macro.displayGoal} g</Text>
          </Text>
          <View style={{
            height: 4,
            backgroundColor: color.surface,
            borderRadius: radius.pill,
            overflow: 'hidden',
            marginTop: space.sm,
          }}>
            <View style={{
              height: 4,
              width: `${(macro.fraction ?? 0) * 100}%`,
              borderRadius: radius.pill,
              backgroundColor: macro.label === 'Protein'
                ? color.macroProtein
                : macro.label === 'Fat'
                  ? color.macroFat
                  : color.macroCarbs,
            }} />
          </View>
        </View>
      ))}
    </View>
  );
}

function TodayCard({ vm, onDashboard }: { vm: TabletViewModel; onDashboard: () => void }): React.JSX.Element {
  const energy = vm.energy;
  const recent = vm.recent.slice(0, 3);
  return (
    <View style={{
      flex: 1,
      minHeight: 440,
      borderRadius: radius.xl,
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      padding: space.xl,
      overflow: 'hidden',
    }}>
      <GlassSheen selected={false} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ color: color.textMuted, fontSize: 12, letterSpacing: 1.3 }}>TODAY</Text>
          <Text style={{ color: color.textPrimary, fontSize: 27, fontWeight: '600', marginTop: 4 }}>Your day at a glance</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open full dashboard"
          onPress={onDashboard}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: radius.pill,
            backgroundColor: pressed ? color.surfaceActive : color.surfaceMuted,
            alignItems: 'center',
            justifyContent: 'center',
          })}
        >
          <Icon name="dashboard" size={20} tint={color.textPrimary} />
        </Pressable>
      </View>

      {energy !== null ? (
        <View style={{ marginTop: space.xl }} accessible accessibilityLabel={energy.semantic}>
          <Text style={{
            color: energy.incomplete
              ? color.textSecondary
              : energy.direction === 'surplus'
                ? color.surplus
                : energy.direction === 'deficit'
                  ? color.deficit
                  : color.neutral,
            fontSize: 64,
            fontWeight: '700',
            letterSpacing: -2.5,
          }}>
            {energy.displayValue}
          </Text>
          <Text style={{ color: color.textSecondary, fontSize: 17, marginTop: 2 }}>{energy.semantic}</Text>
          {energy.projectionNote !== null ? (
            <Text style={{ color: color.textMuted, fontSize: 13, marginTop: 5 }}>{energy.projectionNote}</Text>
          ) : null}
        </View>
      ) : null}

      <MacroStrip vm={vm} />

      <View style={{ marginTop: space.xl, flex: 1 }}>
        <Text style={{ color: color.textMuted, fontSize: 12, letterSpacing: 1.2 }}>RECENT</Text>
        {recent.length === 0 ? (
          <Text style={{ color: color.textSecondary, fontSize: 16, marginTop: space.md }}>
            Nothing logged yet. Your first food will appear here.
          </Text>
        ) : (
          recent.map((food, index) => (
            <View
              key={`${food.displayName}-${String(index)}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: space.sm,
                borderBottomWidth: index === recent.length - 1 ? 0 : 1,
                borderBottomColor: color.border,
              }}
            >
              <Text numberOfLines={1} style={{ color: color.textPrimary, fontSize: 16, flex: 1, paddingRight: space.md }}>
                {food.displayName}
              </Text>
              <Text style={{ color: color.textSecondary, fontSize: 14 }}>{food.displayKcal} kcal</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function GuidanceCards({ vm, actions }: { vm: TabletViewModel; actions: ScreenActions }): React.JSX.Element | null {
  const offered = [...vm.guidance.candidates, ...vm.guidance.alternatives]
    .filter((candidate, index, all) => all.findIndex((other) => other.productVersionId === candidate.productVersionId) === index)
    .slice(0, 3);
  if (offered.length === 0) return null;
  return (
    <View style={{ marginTop: space.xl, width: '100%' }}>
      <Text style={{ color: color.textMuted, fontSize: 12, letterSpacing: 1.2, textAlign: 'center' }}>SUGGESTED FOR YOU</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: space.md }}>
        {offered.map((candidate) => (
          <FoodCard
            key={candidate.productVersionId}
            name={candidate.displayName}
            selected={vm.selectedFood?.productVersionId === candidate.productVersionId}
            accessibilityLabel={`Choose ${candidate.displayName}`}
            onPress={() => {
              if (vm.guidance.envelopeId !== null) {
                actions.onChooseGuidanceCandidate(candidate.productVersionId, vm.guidance.envelopeId);
              }
            }}
          />
        ))}
      </View>
    </View>
  );
}

function PremiumHome(
  { vm, actions, onDashboard }: { vm: TabletViewModel; actions: ScreenActions; onDashboard: () => void },
): React.JSX.Element {
  const { width } = useWindowDimensions();
  const wide = width >= 980;
  const state = voiceOrbState(vm, actions);
  const orbPress = actions.onConversation ?? actions.onOrbPress ?? actions.onRequestGuidance;
  const prompt = state === 'listening'
    ? 'I’m listening.'
    : state === 'thinking'
      ? 'Working on it.'
      : state === 'speaking'
        ? 'Here’s what I found.'
        : 'What are we making?';
  const supporting = actions.voiceFeedback
    ?? (vm.guidance.text.length > 0 ? vm.guidance.text : 'Speak naturally, weigh your portion, and Macros handles the rest.');

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: space.xl,
        paddingTop: space.sm,
        paddingBottom: space.xxxl,
      }}
    >
      <View style={{
        flexDirection: wide ? 'row' : 'column',
        gap: space.xl,
        flex: 1,
        maxWidth: 1320,
        width: '100%',
        alignSelf: 'center',
      }}>
        <View style={{
          flex: wide ? 1.08 : undefined,
          minHeight: 440,
          borderRadius: radius.xl,
          backgroundColor: color.surface,
          borderWidth: 1,
          borderColor: color.border,
          paddingHorizontal: space.xl,
          paddingVertical: space.xxl,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <GlassSheen selected={state !== 'idle'} />
          <MacrosOrb
            state={state}
            size={wide ? 210 : 180}
            accessibilityLabel="Talk to Macros"
            onPress={orbPress}
            disabled={!vm.offline.canLog || vm.voice === 'logging'}
            level={actions.micLevel ?? 0}
            wakePulse={actions.wakePulse ?? 0}
          />
          <Text
            accessibilityRole="header"
            style={{
              color: color.textPrimary,
              fontSize: wide ? 43 : 36,
              fontWeight: '600',
              letterSpacing: -1.3,
              textAlign: 'center',
              marginTop: space.xl,
            }}
          >
            {prompt}
          </Text>
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color: color.textSecondary,
              fontSize: 17,
              lineHeight: 25,
              maxWidth: 560,
              textAlign: 'center',
              marginTop: space.sm,
            }}
          >
            {supporting}
          </Text>

          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xl, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add food"
              onPress={actions.onAddFood}
              style={({ pressed }) => ({
                minHeight: 58,
                paddingHorizontal: space.lg,
                borderRadius: radius.pill,
                backgroundColor: pressed ? color.accentPressed : color.accent,
                flexDirection: 'row',
                gap: space.sm,
                alignItems: 'center',
              })}
            >
              <Icon name="plus" size={19} tint={color.onAccent} />
              <Text style={{ color: color.onAccent, fontSize: 17, fontWeight: '700' }}>Add food</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ask Macros for a food suggestion"
              disabled={vm.guidance.phase === 'thinking'}
              onPress={actions.onRequestGuidance}
              style={({ pressed }) => ({
                minHeight: 58,
                paddingHorizontal: space.lg,
                borderRadius: radius.pill,
                backgroundColor: pressed ? color.surfaceActive : color.surfaceMuted,
                borderWidth: 1,
                borderColor: color.border,
                flexDirection: 'row',
                gap: space.sm,
                alignItems: 'center',
                opacity: vm.guidance.phase === 'thinking' ? 0.55 : 1,
              })}
            >
              <Icon name="leaf" size={19} tint={color.macroCarbs} />
              <Text style={{ color: color.textPrimary, fontSize: 17, fontWeight: '600' }}>Suggest something</Text>
            </Pressable>
          </View>

          {vm.scale.displayWeight !== null ? (
            <View style={{
              marginTop: space.lg,
              borderRadius: radius.pill,
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              backgroundColor: color.surfaceMuted,
              borderWidth: 1,
              borderColor: color.border,
            }}>
              <Text style={{ color: color.textSecondary, fontSize: 14 }}>Scale · {vm.scale.displayWeight}</Text>
            </View>
          ) : null}

          <GuidanceCards vm={vm} actions={actions} />
        </View>

        <TodayCard vm={vm} onDashboard={onDashboard} />
      </View>
    </ScrollView>
  );
}

function Dock(
  {
    page,
    setPage,
    onAddFood,
  }:
  { page: HomePage; setPage: (page: HomePage) => void; onAddFood: () => void },
): React.JSX.Element {
  return (
    <View style={{
      position: 'absolute',
      bottom: space.lg,
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: color.surface,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.border,
      padding: 6,
      gap: 4,
    }}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: page === 'home' }}
        accessibilityLabel="Home"
        onPress={() => setPage('home')}
        style={{
          minWidth: 108,
          minHeight: 50,
          borderRadius: radius.pill,
          backgroundColor: page === 'home' ? color.surfaceActive : color.surface,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.xs,
        }}
      >
        <Icon name="home" size={18} tint={page === 'home' ? color.textPrimary : color.textMuted} />
        <Text style={{ color: page === 'home' ? color.textPrimary : color.textMuted, fontSize: 14 }}>Home</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add food"
        onPress={onAddFood}
        style={({ pressed }) => ({
          width: 54,
          height: 54,
          borderRadius: radius.pill,
          backgroundColor: pressed ? color.accentPressed : color.accent,
          alignItems: 'center',
          justifyContent: 'center',
          marginHorizontal: 4,
        })}
      >
        <Icon name="plus" size={22} tint={color.onAccent} />
      </Pressable>

      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: page === 'dashboard' }}
        accessibilityLabel="Dashboard"
        onPress={() => setPage('dashboard')}
        style={{
          minWidth: 118,
          minHeight: 50,
          borderRadius: radius.pill,
          backgroundColor: page === 'dashboard' ? color.surfaceActive : color.surface,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.xs,
        }}
      >
        <Icon name="dashboard" size={18} tint={page === 'dashboard' ? color.textPrimary : color.textMuted} />
        <Text style={{ color: page === 'dashboard' ? color.textPrimary : color.textMuted, fontSize: 14 }}>Today</Text>
      </Pressable>
    </View>
  );
}

function FlowHeader(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const labels: Readonly<Record<string, string>> = {
    food_search: 'Find food',
    food_options: 'Choose food',
    weighing: 'Weigh portion',
    review: 'Review',
    logged: 'Complete',
  };
  const steps = ['food_search', 'food_options', 'weighing', 'review'];
  const index = steps.indexOf(vm.screen);
  return (
    <View style={{
      minHeight: 78,
      paddingHorizontal: space.xl,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: color.border,
    }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel and return home"
        onPress={actions.onCancel}
        disabled={vm.screen === 'logged'}
        style={{
          width: 48,
          height: 48,
          borderRadius: radius.pill,
          backgroundColor: color.surface,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: vm.screen === 'logged' ? 0 : 1,
        }}
      >
        <Icon name="close" size={18} tint={color.textSecondary} />
      </Pressable>

      <View style={{ alignItems: 'center' }}>
        <Text style={{ color: color.textPrimary, fontSize: 18, fontWeight: '600' }}>
          {labels[vm.screen] ?? 'Add food'}
        </Text>
        {index >= 0 ? (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
            {steps.map((step, stepIndex) => (
              <View
                key={step}
                style={{
                  width: stepIndex <= index ? 28 : 8,
                  height: 5,
                  borderRadius: radius.pill,
                  backgroundColor: stepIndex <= index ? color.accent : color.surfaceMuted,
                }}
              />
            ))}
          </View>
        ) : null}
      </View>

      <View style={{ width: 48, alignItems: 'center' }}>
        <Icon name="leaf" size={18} tint={color.textMuted} />
      </View>
    </View>
  );
}

function LockedScreen({ onSelectMember }: { onSelectMember: () => void }): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
      <View style={{
        width: 112,
        height: 112,
        borderRadius: radius.xl,
        backgroundColor: color.surface,
        borderWidth: 1,
        borderColor: color.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Icon name="leaf" size={42} tint={color.accent} />
      </View>
      <Text style={{ color: color.textPrimary, fontSize: 42, fontWeight: '600', letterSpacing: -1.3, marginTop: space.xl }}>
        Who’s cooking?
      </Text>
      <Text style={{ color: color.textSecondary, fontSize: 17, marginTop: space.sm, textAlign: 'center' }}>
        Choose your profile so every meal stays yours.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose household member"
        onPress={onSelectMember}
        style={({ pressed }) => ({
          minWidth: 280,
          minHeight: 62,
          borderRadius: radius.pill,
          backgroundColor: pressed ? color.accentPressed : color.accent,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: space.xxl,
        })}
      >
        <Text style={{ color: color.onAccent, fontSize: 18, fontWeight: '700' }}>Choose profile</Text>
      </Pressable>
    </View>
  );
}

export function KitchenOS(
  {
    vm,
    actions,
    developmentNotice = null,
  }:
  { vm: TabletViewModel; actions: ScreenActions; developmentNotice?: string | null },
): React.JSX.Element {
  const [page, setPage] = useState<HomePage>('home');
  const [editingGoals, setEditingGoals] = useState(false);
  useEffect(() => {
    setPage('home');
    setEditingGoals(false);
  }, [vm.sessionGeneration]);

  const transitionKey = useMemo(() => `${vm.screen}:${page}:${vm.flowId}`, [vm.screen, page, vm.flowId]);
  const isHome = vm.screen === 'home';

  if (vm.screen === 'locked' || vm.identity === null) {
    return (
      <View style={{ flex: 1, backgroundColor: color.canvas }}>
        <KitchenAtmosphere />
        {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}
        <LockedScreen onSelectMember={actions.onSelectMember} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.canvas }}>
      <KitchenAtmosphere />
      {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}
      {isHome ? <Header vm={vm} actions={actions} /> : <FlowHeader vm={vm} actions={actions} />}

      {vm.offline.message !== null ? (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.sm }}>
          <OfflineStatus offline={vm.offline} />
        </View>
      ) : null}

      <ScreenTransition transitionKey={transitionKey}>
        {vm.screen === 'home' && page === 'home' ? (
          <PremiumHome vm={vm} actions={actions} onDashboard={() => setPage('dashboard')} />
        ) : null}
        {vm.screen === 'home' && page === 'dashboard' ? (
          <DashboardScreen
            vm={vm}
            actions={actions}
            onGenerate={() => { setPage('home'); actions.onRequestGuidance(); }}
            onEditGoals={() => setEditingGoals(true)}
          />
        ) : null}
        {vm.screen === 'food_search' ? <FoodSearchScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_options' ? <FoodOptionsScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'weighing' ? <WeighingScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'review' ? <ReviewScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'logged' ? <LoggedScreen vm={vm} /> : null}
      </ScreenTransition>

      {isHome ? <Dock page={page} setPage={setPage} onAddFood={actions.onAddFood} /> : null}

      {editingGoals ? (
        <GoalSheet
          key={String(vm.daily?.targetDeltaKcal)}
          vm={vm}
          open={editingGoals}
          onClose={() => setEditingGoals(false)}
          onSave={actions.onSaveGoal}
        />
      ) : null}

      {vm.error !== null && vm.screen !== 'food_search' ? (
        <View style={{
          position: 'absolute',
          left: space.xl,
          right: space.xl,
          bottom: isHome ? 96 : space.lg,
          borderRadius: radius.lg,
          backgroundColor: color.surface,
          borderWidth: 1,
          borderColor: color.danger,
          padding: space.md,
        }}>
          <Text accessibilityLiveRegion="assertive" style={{ color: color.danger, fontSize: type.body.size }}>
            {vm.error.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
