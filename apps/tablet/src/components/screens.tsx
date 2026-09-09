import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Animated, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import {
  color, motion, radius, space, touch, type, type TabletViewModel,
} from '@macros/tablet-view-model';
import { PrimaryAction, SecondaryAction, SectionLabel, Surface } from './primitives.js';
import { EnergyBalanceHero } from './EnergyBalanceHero.js';
import { MacroProgress } from './MacroProgress.js';
import { VoiceStateIndicator } from './VoiceStateIndicator.js';
import { ScaleWeightDisplay } from './ScaleWeightDisplay.js';
import { FoodCard, MacroRing, MacrosOrb, type OrbState } from './MacrosOrb.js';
import { FoodOptionCard } from './FoodOptionCard.js';
import {
  DevelopmentBanner, OfflineStatus, RecentFoodRow, TopIdentityBar,
} from './status.js';

export interface ScreenActions {
  /** Push-to-talk. Falls back to the guidance intent when voice is absent. */
  onOrbPress?: () => void;
  readonly isListening?: boolean;
  /** True only while audio is actually playing, so the orb can return to idle. */
  readonly isSpeaking?: boolean;
  /** Smoothed microphone amplitude, 0–1, for the listening waveform. */
  readonly micLevel?: number;
  /** Increments when the wake phrase is heard; the orb pulses once on change. */
  readonly wakePulse?: number;
  readonly onAddFood: () => void;
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

export function HomeScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  /**
   * THE LOCKED REFERENCE.
   *
   *   Hey! Macros
   *   one contextual sentence
   *   the orb
   *   recommendations when active
   *   three macro rings
   *
   * Deliberately not a dashboard. The previous stacked panels read as a
   * tracking app; this has to read as an appliance, which means one focal
   * control and very little text.
   */
  const guidance = vm.guidance;
  /**
   * One orb, four states, in priority order. Speaking is driven by whether
   * audio is ACTUALLY playing — deriving it from the guidance phase left the
   * orb pulsing long after the sentence had finished, which reads as a hung
   * device rather than a speaking one.
   */
  const orbState: OrbState =
    actions.isListening === true ? 'listening'
      : guidance.phase === 'thinking' ? 'thinking'
        : actions.isSpeaking === true ? 'speaking'
          : 'idle';

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: space.xl, paddingTop: space.xl,
        paddingBottom: space.xxl, alignItems: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: color.textPrimary, fontSize: 42, fontWeight: '700',
          marginBottom: space.xs,
        }}
      >
        Hey! Macros
      </Text>

      {/* ONE sentence, produced by the view model. React computes nothing.
          `energy` is legitimately null before the first dashboard resolves, so
          the absence is rendered as its own quiet state rather than reached
          through. */}
      <Text
        style={{
          color: color.textSecondary, fontSize: 20, textAlign: 'center',
          marginBottom: space.xxl, maxWidth: 560,
        }}
      >
        {orbState === 'listening' ? 'Listening…'
          : orbState === 'thinking' ? 'Thinking…'
            : vm.energy === null ? 'What are you eating today?'
              : vm.energy.semantic}
      </Text>

      <MacrosOrb
        state={orbState}
        {...(orbState === 'idle' ? { caption: 'Tap to speak' } : {})}
        level={actions.micLevel ?? 0}
        wakePulse={actions.wakePulse ?? 0}
        accessibilityLabel="Ask Macros what to eat"
        onPress={actions.onOrbPress ?? actions.onRequestGuidance}
        disabled={!vm.offline.canLog}
      />

      {guidance.visible && guidance.text.length > 0 ? (
        <Text
          style={{
            color: color.textPrimary, fontSize: 22, textAlign: 'center',
            marginTop: space.xl, maxWidth: 640,
          }}
        >
          {guidance.text}
        </Text>
      ) : null}

      {guidance.candidates.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingVertical: space.xl }}
        >
          {[...guidance.candidates, ...guidance.alternatives].map((c, index) => (
            <FoodCard
              key={c.productVersionId}
              name={c.displayName}
              selected={index === 0}
              onPress={() => {
                if (guidance.envelopeId !== null) {
                  actions.onChooseGuidanceCandidate(c.productVersionId, guidance.envelopeId);
                }
              }}
              accessibilityLabel={`Choose ${c.displayName}`}
            />
          ))}
        </ScrollView>
      ) : null}

      {/* Projected from the MacroView[] contract in the order the view model
          supplies — Protein, Carbs, Fat. Naming the keys here assumed a shape
          the contract never had, and duplicating the order in React would let
          the two drift. */}
      <View style={{ flexDirection: 'row', marginTop: space.xxl }}>
        {vm.macros.map((macro) => (
          <MacroRing
            key={macro.label}
            label={macro.label}
            value={macro.displayRemaining}
          />
        ))}
      </View>

      {/* Secondary and discreet: the orb is the product, this is the escape. */}
      <Pressable
        onPress={actions.onAddFood}
        accessibilityRole="button"
        accessibilityLabel="Add food"
        style={{ marginTop: space.xl, padding: space.md }}
      >
        <Text style={{ color: color.textMuted, fontSize: 16 }}>Add food manually</Text>
      </Pressable>
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
  const [showManual, setShowManual] = useState(false);
  const weight = vm.scale.displayWeight;
  const parsed = Number(manual);
  // `selectedFood` is genuinely nullable, so it is narrowed rather than
  // coerced to an empty string — a blank line where the food should be reads
  // as a rendering fault, not as a state.
  const selected = vm.selectedFood;

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

      <MacrosOrb
        state="weighing"
        weightLabel={weight ?? '—'}
        caption="Detecting weight"
        accessibilityLabel={weight === null
          ? 'Waiting for a stable weight' : `Weight ${weight}`}
      />

      {selected !== null ? (
        <Text
          style={{
            color: color.textSecondary, fontSize: 22,
            marginTop: space.xl, textAlign: 'center',
          }}
        >
          {selected.displayName}
        </Text>
      ) : null}

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
            keyboardType="number-pad"
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
            label="Confirm"
            accessibilityLabel="Confirm and log this food"
            onPress={actions.onLog}
            disabled={!vm.offline.canLog}
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

      <TopIdentityBar identity={vm.identity}>
        <VoiceStateIndicator presence={vm.voice} />
      </TopIdentityBar>

      {vm.offline.message !== null ? (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.sm }}>
          <OfflineStatus offline={vm.offline} />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {vm.screen === 'home' ? <HomeScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_search' ? <FoodSearchScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_options' ? <FoodOptionsScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'weighing' ? <WeighingScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'review' ? <ReviewScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'logged' ? <LoggedScreen vm={vm} /> : null}
      </View>

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
