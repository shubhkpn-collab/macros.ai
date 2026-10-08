import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Alert, Animated, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import {
  color, motion, radius, space, touch, type, type TabletViewModel,
} from '@macros/tablet-view-model';
import { PrimaryAction, SecondaryAction, SectionLabel, Surface } from './primitives.js';
import { EnergyBalanceHero } from './EnergyBalanceHero.js';
import { MacroProgress } from './MacroProgress.js';
import { VoiceStateIndicator } from './VoiceStateIndicator.js';
import { ScaleWeightDisplay } from './ScaleWeightDisplay.js';
import {
  FoodCard, MacroRing, MacrosOrb, MicButton, type OrbState,
} from './MacrosOrb.js';
import { Icon, IconButton, Ring } from './ReferenceKit.js';
import { DashboardScreen, GoalSheet } from './DashboardScreen.js';
import { FoodOptionCard } from './FoodOptionCard.js';
import {
  DevelopmentBanner, OfflineStatus, RecentFoodRow, TopIdentityBar,
} from './status.js';

export interface ScreenActions {
  onConversation?: () => void;
  conversationActive?: boolean;
  /** Push-to-talk. Falls back to the guidance intent when voice is absent. */
  onOrbPress?: () => void;
  voiceFeedback?: string | null;
  readonly isListening?: boolean;
  /** True only while audio is actually playing, so the orb can return to idle. */
  readonly isSpeaking?: boolean;
  /** Smoothed microphone amplitude, 0–1, for the listening waveform. */
  readonly micLevel?: number;
  /** Increments when the wake phrase is heard; the orb pulses once on change. */
  readonly wakePulse?: number;
  readonly onAddFood: () => void;
  readonly onSaveGoal: (delta: number) => Promise<boolean>;
  readonly onRequestGuidance: () => void;
  readonly onChooseGuidanceCandidate: (productVersionId: string, envelopeId: string) => void;
  readonly onSearchFood: (query: string) => void;
  readonly onEnterManualWeight: (grams: number) => void;
  readonly onSelectOption: (productVersionId: string) => void;
  readonly onUseWeight: () => void;
  readonly onLog: () => void;
  readonly onChangeFood: () => void;
  readonly onChangeWeight: () => void;
  readonly onCancel: () => void;
  readonly onSelectMember: () => void;
}

/** Shared field styling, so search and manual weight feel like one product. */
const fieldStyle = {
  minHeight: touch.fieldHeight,
  borderRadius: radius.md,
  backgroundColor: color.surface,
  borderWidth: 1,
  borderColor: color.border,
  color: color.textPrimary,
  fontSize: type.metric.size,
  paddingHorizontal: space.lg,
} as const;

/**
 * LOCKED / NEUTRAL.
 *
 * Rendered from `lockedViewModel()`, which is built without reading app state,
 * so there is no field of the previous occupant's day available to leak.
 */
export function LockedHouseholdScreen(
  { onSelectMember }: { onSelectMember: () => void },
): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
      <Text style={{
        color: color.textMuted, fontSize: type.productLabel.size,
        fontWeight: type.productLabel.weight, letterSpacing: type.productLabel.tracking,
      }}>
        MACROS
      </Text>
      <Text style={{
        color: color.textPrimary, fontSize: type.screenTitle.size, fontWeight: '600',
        marginTop: space.lg,
      }}>
        Who's cooking?
      </Text>
      <Text style={{
        color: color.textSecondary, fontSize: type.body.size,
        marginTop: space.sm, marginBottom: space.xxxl, textAlign: 'center',
      }}>
        Choose a household member to begin
      </Text>
      <View style={{ alignSelf: 'stretch', paddingHorizontal: space.xxxl }}>
        <PrimaryAction
          label="Select member"
          accessibilityLabel="Select a household member to sign in"
          onPress={onSelectMember}
        />
      </View>
    </View>
  );
}

function MacroFooter({ vm }: { vm: TabletViewModel }): React.JSX.Element {
  return <View style={{ flexDirection: 'row', width: '100%', maxWidth: 640, marginTop: 32, paddingBottom: 14 }}>
    {vm.macros.map((macro) => <Ring key={macro.label} label={macro.label} value={macro.displayConsumed} goal={macro.displayGoal} fraction={macro.fraction} size={98} />)}
    <Ring label="Calories" value={vm.daily?.displayCalories ?? '—'} goal={vm.daily?.displayCalorieGoal} fraction={vm.daily?.calorieFraction ?? null} size={98} />
  </View>;
}
export function HomeScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const guidance = vm.guidance;
  const orbState: OrbState = actions.isListening === true || actions.conversationActive === true ? 'listening'
    : guidance.phase === 'thinking' ? 'thinking' : actions.isSpeaking === true ? 'speaking' : 'idle';
  const offered = [...guidance.candidates, ...guidance.alternatives].filter((c,i,all) => all.findIndex(other => other.productVersionId === c.productVersionId) === i).slice(0,3);
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 32, paddingTop: 48, alignItems: 'center', maxWidth: 760, width: '100%', alignSelf: 'center' }}>
    <MacrosOrb state={orbState} size={124} accessibilityLabel="Ask Macros what to eat" onPress={actions.onConversation ?? actions.onOrbPress ?? actions.onRequestGuidance} disabled={!vm.offline.canLog || vm.voice === 'logging'} level={actions.micLevel ?? 0} wakePulse={actions.wakePulse ?? 0} />
    <Text accessibilityRole="header" style={{ color: color.textPrimary, fontSize: 42, fontStyle: 'italic', fontWeight: '700', marginTop: 32 }}>Hey! Macros</Text>
    <Text style={{ color: color.textSecondary, fontSize: 23, textAlign: 'center', marginTop: 10, lineHeight: 31 }}>{orbState === 'listening' ? 'Listening…' : orbState === 'thinking' ? 'Thinking…' : 'What are you eating today?'}</Text>
    <View style={{ marginVertical: 24 }}><MicButton active={orbState === 'listening'} onPress={actions.onConversation ?? actions.onOrbPress ?? actions.onRequestGuidance} accessibilityLabel="Speak to Macros" /></View>
    <Text style={{ color: color.textSecondary, fontSize: 17 }}>{vm.scale.displayWeight === null ? 'Select a food, then weigh your portion' : `Current weight: ${vm.scale.displayWeight}`}</Text>
    {offered.length > 0 ? <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'center', marginTop: 28, marginBottom: 20 }}>{offered.map(c => <FoodCard key={c.productVersionId} name={c.displayName} selected={vm.selectedFood !== null && vm.selectedFood.productVersionId === c.productVersionId} onPress={() => { if (guidance.envelopeId !== null) actions.onChooseGuidanceCandidate(c.productVersionId, guidance.envelopeId); }} accessibilityLabel={`Choose ${c.displayName}`} />)}</View> : <Pressable accessibilityRole="button" accessibilityLabel="Search for a food" onPress={actions.onAddFood} style={({ pressed }) => ({ width: '100%', marginTop: 30, borderWidth: 1, borderColor: color.borderStrong, borderRadius: 24, padding: 30, backgroundColor: pressed ? color.surfaceActive : color.surface, alignItems: 'center' })}><Icon name="search" size={32} tint={color.macroProtein} /><Text style={{ color: color.textPrimary, fontSize: 23, fontWeight: '600', marginTop: 14 }}>Find your food</Text><Text style={{ color: color.textMuted, fontSize: 16, marginTop: 8 }}>Search the catalog or ask Macros for an idea</Text></Pressable>}
    {guidance.text.length > 0 ? <View accessibilityLiveRegion="polite" style={{ marginTop: 18, backgroundColor: color.surface, padding: 18, borderRadius: 22, width: '100%' }}><Text style={{ color: color.textSecondary, fontSize: 18, lineHeight: 26, textAlign: 'center' }}>{guidance.text}</Text></View> : null}
    <View style={{ flexDirection: 'row', marginTop: 24, gap: 12 }}><Pressable accessibilityRole="button" accessibilityLabel="Add food" onPress={actions.onAddFood} style={{ padding: 16, borderRadius: 26, backgroundColor: color.surfaceMuted, flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon name="plus" size={20} /><Text style={{ color: color.textPrimary, fontSize: 17 }}>Add food</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Suggest a food" disabled={guidance.phase === 'thinking'} onPress={actions.onRequestGuidance} style={{ padding: 16, borderRadius: 26, backgroundColor: color.surfaceMuted, flexDirection: 'row', gap: 10, alignItems: 'center', opacity: guidance.phase === 'thinking' ? .5 : 1 }}><Icon name="leaf" size={20} /><Text style={{ color: color.textPrimary, fontSize: 17 }}>Suggest a food</Text></Pressable></View>
    {actions.onConversation ? <View style={{ width: '100%', marginTop: 24 }}><PrimaryAction accessibilityLabel="Toggle kitchen voice conversation" label={actions.conversationActive ? 'End kitchen conversation' : 'Start kitchen conversation'} onPress={actions.onConversation} /><Text style={{ color: color.textMuted, textAlign: 'center', marginTop: 10 }}>AI voice • listens while connected • ends after 5 minutes</Text></View> : null}
    {vm.energy !== null ? <EnergyBalanceHero energy={vm.energy} /> : null}
    <MacroFooter vm={vm} />
  </ScrollView>
  );
}

export function FoodSearchScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const [query, setQuery] = useState(vm.searchQuery);
  const canSearch = query.trim().length > 0;
  const submit = (): void => { if (canSearch) actions.onSearchFood(query.trim()); };

  return (
    <View style={{ flex: 1, paddingHorizontal: space.xl, justifyContent: 'space-between' }}>
      <View style={{ paddingTop: space.xl }}>
        <Text style={{
          color: color.textPrimary, fontSize: type.screenTitle.size,
          fontWeight: '600', letterSpacing: type.screenTitle.tracking,
        }}>
          What are you adding?
        </Text>
        <Text style={{ color: color.textMuted, fontSize: type.body.size, marginTop: space.sm }}>
          Or say "Hey Macros" when voice is available
        </Text>

        <TextInput
          accessibilityLabel="Food name"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={submit}
          returnKeyType="search"
          autoFocus
          placeholder="Chicken breast…"
          placeholderTextColor={color.textMuted}
          style={{ ...fieldStyle, marginTop: space.xl }}
        />

        {vm.error !== null ? (
          // The trusted error from the controller — never reworded here.
          <Text style={{ color: color.danger, fontSize: type.body.size, marginTop: space.lg }}>
            {vm.error.message}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: space.md, paddingBottom: space.xxl }}>
        <PrimaryAction
          label="Search"
          accessibilityLabel="Search for this food"
          disabled={!canSearch}
          onPress={submit}
        />
        <SecondaryAction label="Cancel" accessibilityLabel="Cancel adding food" onPress={actions.onCancel} />
      </View>
    </View>
  );
}

export function FoodOptionsScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  return (
    <View style={{ flex: 1, paddingHorizontal: space.xl }}>
      <Text style={{
        color: color.textPrimary, fontSize: type.screenTitle.size,
        fontWeight: '600', paddingTop: space.lg, paddingBottom: space.lg,
      }}>
        Which one?
      </Text>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {vm.options.map((o) => (
          <FoodOptionCard key={o.productVersionId} option={o} onSelect={actions.onSelectOption} />
        ))}
      </ScrollView>

      <View style={{ paddingVertical: space.lg }}>
        <SecondaryAction label="Cancel" accessibilityLabel="Cancel adding food" onPress={actions.onCancel} />
      </View>
    </View>
  );
}

/**
 * WEIGHING — a signature screen.
 *
 * The selected food is named at the top, so the weight is never floating free
 * of what is being weighed.
 */
export function WeighingScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  /**
   * The orb becomes the scale. Grams dominate; the food sits quietly beneath.
   * Manual entry stays reachable but visually secondary — it is the fallback,
   * not the interaction the product is selling.
   */
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(!vm.scale.connected);
  const weight = vm.scale.displayWeight;
  const parsed = Number(manual);
  // `selectedFood` is genuinely nullable, so it is narrowed rather than
  // coerced to an empty string — a blank line where the food should be reads
  // as a rendering fault, not as a state.
  const selected = vm.selectedFood;
  const siblings = vm.options.filter(option => selected !== null && option.productVersionId !== selected.productVersionId).slice(0, 2);
  const weightCards = selected === null ? [] : [siblings[0], selected, siblings[1]].filter(card => card !== undefined);


  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: space.xl, paddingTop: space.xl,
        paddingBottom: space.xxl, alignItems: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={{ color: color.textPrimary, fontSize: 34, fontWeight: '600' }}>
        Hey! Macros
      </Text>

      {/* The validated guidance line, rendered rather than re-worded: the
          sentence belongs to the guidance templates, not to React. */}
      {vm.guidance.phase === 'awaiting_weight' && vm.guidance.text.length > 0 ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            color: color.accent, fontSize: 20, marginTop: space.sm,
            marginBottom: space.xl, textAlign: 'center',
          }}
        >
          {vm.guidance.text}
        </Text>
      ) : (
        <Text
          style={{
            color: color.textSecondary, fontSize: 20, marginTop: space.sm,
            marginBottom: space.xl, textAlign: 'center',
          }}
        >
          {vm.scale.message}
        </Text>
      )}

      <MacrosOrb state={actions.isListening ? 'listening' : 'idle'} size={100} accessibilityLabel="Speak while weighing food" onPress={actions.onOrbPress ?? actions.onRequestGuidance} level={actions.micLevel ?? 0} />
      <View style={{ marginTop: 28 }}><MicButton active={actions.isListening === true} onPress={actions.onOrbPress ?? actions.onRequestGuidance} accessibilityLabel="Speak to Macros while weighing" /></View>
      <Text accessibilityLiveRegion="polite" style={{ color: color.textPrimary, fontSize: 26, fontWeight: '600', marginTop: 22 }}>
        {weight === null ? 'Enter your portion weight' : `Current weight: ${weight}`}
      </Text>
      <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'center', marginTop: 28, marginBottom: 24 }}>
        {weightCards.map(card => <FoodCard key={card.productVersionId} name={card.displayName} detail={card.preparationState} selected={selected !== null && card.productVersionId === selected.productVersionId} onPress={() => { if (selected !== null && card.productVersionId === selected.productVersionId) setShowManual(true); else actions.onSelectOption(card.productVersionId); }} accessibilityLabel={`Choose ${card.displayName} for this portion`} />)}
      </View>
      <View style={{ flexDirection: 'row', backgroundColor: color.surface, borderRadius: 30, marginTop: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Unselect food" onPress={actions.onCancel} style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="close" size={20} /><Text style={{ color: color.textSecondary, fontSize: 17 }}>Unselect food</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Change food" onPress={actions.onChangeFood} style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="edit" size={20} /><Text style={{ color: color.textSecondary, fontSize: 17 }}>Change food</Text></Pressable>
      </View>

      {/* The real-scale path stays primary. */}
      <View style={{ marginTop: space.xl, width: 320 }}>
        <PrimaryAction
          label="Use this weight"
          accessibilityLabel="Use this weight"
          onPress={actions.onUseWeight}
          disabled={!vm.scale.canCommitWeight}
        />
      </View>

      {/* The fallback is offered only when there is no scale to fall back FROM,
          and stays visually secondary when it is. */}
      {!vm.scale.connected && !showManual ? (
        <Pressable
          onPress={() => { setShowManual(true); }}
          accessibilityRole="button"
          accessibilityLabel="Enter weight manually"
          style={{ marginTop: space.xl, padding: space.md }}
        >
          <Text style={{ color: color.textMuted, fontSize: 16 }}>
            Enter weight manually
          </Text>
        </Pressable>
      ) : null}

      {showManual ? (
        <View style={{ marginTop: space.xl, width: 320, opacity: 0.9 }}>
          <TextInput
            value={manual}
            onChangeText={setManual}
            keyboardType="decimal-pad"
            placeholder="Grams"
            placeholderTextColor={color.textMuted}
            accessibilityLabel="Weight in grams"
            style={{
              color: color.textPrimary, fontSize: type.body.size,
              borderBottomWidth: 1, borderBottomColor: color.surfaceMuted,
              paddingVertical: space.md, textAlign: 'center',
            }}
          />
          <View style={{ marginTop: space.md }}>
            <SecondaryAction
              label="Use entered weight"
              accessibilityLabel="Use entered weight"
              // Parsed ONLY to enable the action; the controller owns the value
              // and nothing in the UI is derived from it.
              disabled={!(Number.isFinite(parsed) && parsed > 0)}
              onPress={() => { actions.onEnterManualWeight(parsed); }}
            />
          </View>
        </View>
      ) : null}

      <MacroFooter vm={vm} />
      <Pressable
        onPress={actions.onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{ marginTop: space.xl, padding: space.md }}
      >
        <Text style={{ color: color.textMuted, fontSize: 16 }}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

export function ReviewScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const r = vm.review;
  if (r === null) return <View />;

  /**
   * The confirmation, to the locked reference: one sentence, four circular
   * figures, two actions. Every value is a pre-formatted string from the view
   * model — React does no nutrition arithmetic, here or anywhere.
   */
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: space.xl, paddingTop: space.xxl,
        paddingBottom: space.xxl, alignItems: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      <Text
        style={{ color: color.textSecondary, fontSize: 22, textAlign: 'center' }}
      >
        Confirm {r.displayGrams} of
      </Text>
      <Text
        accessibilityRole="header"
        style={{
          color: color.textPrimary, fontSize: 32, fontWeight: '600',
          textAlign: 'center', marginTop: space.xs, marginBottom: space.xxl,
        }}
      >
        {r.displayName}
      </Text>

      <View style={{ flexDirection: 'row', marginBottom: space.xl }}>
        <MacroRing label="Protein" value={r.displayProtein} />
        <MacroRing label="Calories" value={r.displayKcal} />
      </View>
      <View style={{ flexDirection: 'row' }}>
        <MacroRing label="Carbs" value={r.displayCarbs} />
        <MacroRing label="Fat" value={r.displayFat} />
      </View>

      <View style={{ flexDirection: 'row', marginTop: space.xxl, gap: space.lg }}>
        <View style={{ width: 220 }}>
          <SecondaryAction
            label="Edit weight"
            accessibilityLabel="Edit weight"
            onPress={actions.onChangeWeight}
          />
        </View>
        <View style={{ width: 220 }}>
          <PrimaryAction
            label={vm.voice === 'logging' ? 'Logging…' : 'Confirm'}
            accessibilityLabel="Confirm and log this food"
            onPress={actions.onLog}
            disabled={!vm.offline.canLog || vm.voice === 'logging'}
          />
        </View>
      </View>
    </ScrollView>
  );
}

export function LoggedScreen({ vm }: { vm: TabletViewModel }): React.JSX.Element {
  const scale = useRef(new Animated.Value(0.86)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced) { scale.setValue(1); fade.setValue(1); return; }
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7 }),
        Animated.timing(fade, {
          toValue: 1, duration: motion.normal, useNativeDriver: true,
        }),
      ]).start();
    });
    return () => { cancelled = true; };
  }, [scale, fade]);

  return (
    <View
      accessible
      accessibilityLiveRegion="assertive"
      accessibilityLabel={vm.offline.offline ? 'Logged. Waiting to sync.' : 'Logged'}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View style={{ opacity: fade, transform: [{ scale }], alignItems: 'center' }}>
        <View style={{
          width: 132, height: 132, borderRadius: radius.pill,
          backgroundColor: color.accentMuted,
          borderWidth: 2, borderColor: color.accent,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ color: color.accent, fontSize: 64, fontWeight: '700' }}>✓</Text>
        </View>

        <Text style={{
          color: color.textPrimary, fontSize: type.screenTitle.size,
          fontWeight: '600', marginTop: space.xl,
        }}>
          Logged
        </Text>

        {vm.review !== null ? (
          <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.sm }}>
            {vm.review.displayName} · {vm.review.displayGrams}
          </Text>
        ) : null}

        {vm.offline.offline ? (
          <Text style={{ color: color.textMuted, fontSize: type.caption.size, marginTop: space.md }}>
            Waiting to sync
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** Root shell: presence, status, then the current screen. */
export function TabletShell(
  { vm, actions, developmentNotice = null }:
  { vm: TabletViewModel; actions: ScreenActions; developmentNotice?: string | null },
): React.JSX.Element {
  const [page, setPage] = useState<'home' | 'dashboard'>('home');
  const [editingGoals, setEditingGoals] = useState(false);
  useEffect(() => { setPage('home'); setEditingGoals(false); }, [vm.sessionGeneration]);
  const isDashboard = page === 'dashboard' && vm.screen === 'home';
  const onGenerate = () => { setPage('home'); actions.onRequestGuidance(); };
  if (vm.screen === 'locked' || vm.identity === null) {
    return (
      <View style={{ flex: 1, backgroundColor: color.canvas }}>
        {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}
        <LockedHouseholdScreen onSelectMember={actions.onSelectMember} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.canvas }}>
      {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}><IconButton name="user" label={`Active profile: ${vm.identity.displayName}`} onPress={() => { Alert.alert('Your profile', `${vm.identity?.displayName ?? ''} is the active profile.${developmentNotice === null ? '' : ' This preview uses a demo profile; real member sign-in is not configured.'}`, developmentNotice === null ? [{ text: 'Close' }, { text: 'Switch member', onPress: actions.onSelectMember }] : [{ text: 'Close' }]); }} /><Text style={{ color: color.textMuted, fontSize: 15 }}>{vm.identity.displayName}</Text></View>
        <Text style={{ color: color.textPrimary, fontSize: 24, fontWeight: '700', fontStyle: 'italic' }}>Hey! Macros</Text>
        <View style={{ flexDirection: 'row' }}><IconButton name="mic" label={actions.isListening ? "Stop listening" : "Speak a command"} active={actions.isListening === true} onPress={actions.onOrbPress ?? actions.onRequestGuidance} /><IconButton name="search" label="Search foods" onPress={actions.onAddFood} /><IconButton name="menu" label="Open app menu" onPress={() => { Alert.alert('Macros', 'Choose a screen', [{ text: 'Home', onPress: () => { actions.onCancel(); setPage('home'); } }, { text: 'Dashboard', onPress: () => { actions.onCancel(); setPage('dashboard'); } }, { text: 'Cancel', style: 'cancel' }]); }} /></View>
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: color.textMuted, textAlign: 'center', paddingHorizontal: 24, paddingBottom: 10, fontSize: 14 }}>{actions.voiceFeedback ?? (actions.isListening ? 'Listening… speak your command' : vm.screen === 'home' || vm.screen === 'food_search' ? 'Tap the microphone: “Search for tofu” or “What should I eat?”' : vm.screen === 'food_options' ? 'Tap the microphone: “Option one”, “Option two”, or “Cancel”' : vm.screen === 'weighing' ? 'Tap the microphone: “94.5 grams” or “Use scale weight”' : vm.screen === 'review' ? 'Check your portion, then tap the microphone and say “Confirm”' : 'Food logged')}</Text>
      {vm.screen === 'home' ? <View style={{ flexDirection: 'row', alignSelf: 'center', backgroundColor: color.surface, borderRadius: 30, padding: 5, marginBottom: 10 }}>
        {(['home', 'dashboard'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: page === tab }} accessibilityLabel={tab === 'home' ? 'Home tab' : 'Dashboard tab'} onPress={() => setPage(tab)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 22, paddingVertical: 14, borderRadius: 26, backgroundColor: page === tab ? color.surfaceActive : 'transparent' }}><Icon name={tab} size={18} tint={page === tab ? color.macroProtein : color.textMuted} /><Text style={{ color: page === tab ? color.textPrimary : color.textMuted, fontSize: 16 }}>{tab === 'home' ? 'Home' : 'Dashboard'}</Text></Pressable>)}
      </View> : null}

      {vm.offline.message !== null ? (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.sm }}>
          <OfflineStatus offline={vm.offline} />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {vm.screen === 'home' ? isDashboard ? <DashboardScreen vm={vm} actions={actions} onGenerate={onGenerate} onEditGoals={() => setEditingGoals(true)} /> : <HomeScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_search' ? <FoodSearchScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_options' ? <FoodOptionsScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'weighing' ? <WeighingScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'review' ? <ReviewScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'logged' ? <LoggedScreen vm={vm} /> : null}
      </View>

      {editingGoals ? <GoalSheet key={String(vm.daily?.targetDeltaKcal)} vm={vm} open={editingGoals} onClose={() => setEditingGoals(false)} onSave={actions.onSaveGoal} /> : null}
      {vm.error !== null && vm.screen !== 'food_search' ? (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.lg }}>
          <Text style={{ color: color.danger, fontSize: type.body.size }}>
            {vm.error.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
