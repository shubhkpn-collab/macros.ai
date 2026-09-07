import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Animated, ScrollView, Text, TextInput, View,
} from 'react-native';
import {
  color, motion, radius, space, touch, type, type TabletViewModel,
} from '@macros/tablet-view-model';
import { PrimaryAction, SecondaryAction, SectionLabel, Surface } from './primitives.js';
import { EnergyBalanceHero } from './EnergyBalanceHero.js';
import { MacroProgress } from './MacroProgress.js';
import { VoiceStateIndicator } from './VoiceStateIndicator.js';
import { ScaleWeightDisplay } from './ScaleWeightDisplay.js';
import { FoodOptionCard } from './FoodOptionCard.js';
import {
  DevelopmentBanner, OfflineStatus, RecentFoodRow, TopIdentityBar,
} from './status.js';

export interface ScreenActions {
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
  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.lg }}
      showsVerticalScrollIndicator={false}
    >
      {vm.energy !== null ? (
        <Surface tone="hero" style={{ paddingVertical: space.lg }}>
          <EnergyBalanceHero energy={vm.energy} />
        </Surface>
      ) : null}

      {vm.macros.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <SectionLabel>Macros today</SectionLabel>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            {vm.macros.map((m) => <MacroProgress key={m.label} macro={m} />)}
          </View>
        </View>
      ) : null}

      <PrimaryAction
        label="What should I eat?"
        accessibilityLabel="Ask what to eat"
        onPress={actions.onRequestGuidance}
        disabled={!vm.offline.canLog}
      />

      {vm.guidance.visible ? (
        // Minimal by design: AI-0 is functional integration, and the premium
        // visual treatment is a later milestone against the locked reference.
        <Surface>
          <SectionLabel>Macros suggests</SectionLabel>
          <Text style={{
            color: color.textPrimary, fontSize: type.body.size, marginTop: space.sm,
          }}>
            {vm.guidance.text}
          </Text>

          {vm.guidance.candidates.map((c) => (
            <View key={c.productVersionId} style={{ marginTop: space.md }}>
              <SecondaryAction
                label={c.displayName}
                accessibilityLabel={`Choose ${c.displayName}`}
                onPress={() => {
                  if (vm.guidance.envelopeId !== null) {
                    actions.onChooseGuidanceCandidate(c.productVersionId, vm.guidance.envelopeId);
                  }
                }}
              />
            </View>
          ))}

          {vm.guidance.alternatives.length > 0 ? (
            <View style={{ marginTop: space.lg }}>
              <SectionLabel>Or</SectionLabel>
              {vm.guidance.alternatives.map((c) => (
                <View key={c.productVersionId} style={{ marginTop: space.sm }}>
                  <SecondaryAction
                    label={c.displayName}
                    accessibilityLabel={`Choose ${c.displayName}`}
                    tone="quiet"
                    // The SAME validated intent as a primary candidate.
                    onPress={() => {
                      if (vm.guidance.envelopeId !== null) {
                        actions.onChooseGuidanceCandidate(
                          c.productVersionId, vm.guidance.envelopeId);
                      }
                    }}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </Surface>
      ) : null}

      <SecondaryAction
        label="Add food"
        accessibilityLabel="Add food"
        onPress={actions.onAddFood}
      />

      {vm.recent.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <SectionLabel>Logged today</SectionLabel>
          <Surface>
            {vm.recent.map((r, i) => (
              <RecentFoodRow key={`${r.displayName}-${i}`} name={r.displayName} displayKcal={r.displayKcal} />
            ))}
          </Surface>
        </View>
      ) : null}
    </ScrollView>
  );
}

/**
 * TOUCH FALLBACK SEARCH.
 *
 * Voice is the primary interaction and the mic is a later milestone, so this is
 * explicitly a fallback: calm, roomy, and not dressed up as the brand's main
 * identity.
 */
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
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(false);

  // Parsing decides button enablement ONLY. The controller still validates, the
  // capture keeps manual provenance, and no scale stability is fabricated.
  const parsed = Number.parseFloat(manual);
  const manualUsable = Number.isFinite(parsed) && parsed > 0;

  const food = vm.selectedFood;

  return (
    <View style={{ flex: 1, paddingHorizontal: space.xl, justifyContent: 'space-between' }}>
      <View style={{ paddingTop: space.lg }}>
        <SectionLabel>Weighing</SectionLabel>
        <Text
          numberOfLines={2}
          style={{
            color: color.textPrimary, fontSize: type.screenTitle.size,
            fontWeight: '600', marginTop: space.xs,
          }}
        >
          {food?.displayName ?? 'Selected food'}
        </Text>
        {food !== null ? (
          <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.xxs }}>
            {food.brand !== null ? `${food.brand} · ` : ''}{food.preparationState}
          </Text>
        ) : null}
      </View>

      {vm.guidance.phase === 'awaiting_weight' && vm.guidance.text.length > 0 ? (
        // The already-validated deterministic text, rendered rather than
        // duplicated: React must never author guidance wording.
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={vm.guidance.text}
          style={{ paddingHorizontal: space.md, paddingTop: space.md }}
        >
          <Text style={{ color: color.accent, fontSize: type.body.size, textAlign: 'center' }}>
            {vm.guidance.text}
          </Text>
        </View>
      ) : null}

      <ScaleWeightDisplay scale={vm.scale} />

      <View style={{ gap: space.md, paddingBottom: space.xxl }}>
        <PrimaryAction
          label="Use this weight"
          accessibilityLabel="Use this weight"
          // Only a settled candidate may be committed.
          disabled={!vm.scale.canCommitWeight}
          onPress={actions.onUseWeight}
        />

        {!vm.scale.connected && !showManual ? (
          <SecondaryAction
            label="Enter weight manually"
            accessibilityLabel="Enter weight manually instead of using the scale"
            onPress={() => setShowManual(true)}
          />
        ) : null}

        {showManual ? (
          <View style={{ gap: space.md }}>
            <TextInput
              accessibilityLabel="Weight in grams"
              value={manual}
              onChangeText={setManual}
              keyboardType="numeric"
              placeholder="Grams"
              placeholderTextColor={color.textMuted}
              style={fieldStyle}
            />
            <PrimaryAction
              label="Continue"
              accessibilityLabel="Continue with the manually entered weight"
              disabled={!manualUsable}
              onPress={() => actions.onEnterManualWeight(parsed)}
            />
          </View>
        ) : null}

        <SecondaryAction
          label="Change food"
          accessibilityLabel="Change food"
          tone="quiet"
          onPress={actions.onChangeFood}
        />
      </View>
    </View>
  );
}

/** REVIEW — "is this exactly what I'm about to log?" */
export function ReviewScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const r = vm.review;
  if (r === null) return <View />;

  return (
    <View style={{ flex: 1, paddingHorizontal: space.xl, justifyContent: 'space-between' }}>
      <View style={{ paddingTop: space.lg }}>
        <SectionLabel>Review</SectionLabel>
        <Text
          numberOfLines={2}
          style={{
            color: color.textPrimary, fontSize: type.screenTitle.size,
            fontWeight: '600', marginTop: space.xs,
          }}
        >
          {r.displayName}
        </Text>
        <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.xxs }}>
          {r.brand !== null ? `${r.brand} · ` : ''}{r.preparationState}
        </Text>

        <Surface tone="hero" style={{ marginTop: space.xl, alignItems: 'center' }}>
          <Text style={{ color: color.textSecondary, fontSize: type.metric.size }}>
            {r.displayGrams}
          </Text>
          <Text style={{
            color: color.textPrimary, fontSize: type.energyHero.size * 0.62,
            fontWeight: '700', letterSpacing: -2, marginTop: space.xs,
          }}>
            {r.displayKcal}
          </Text>
          <Text style={{ color: color.textMuted, fontSize: type.sectionLabel.size, letterSpacing: 2 }}>
            KCAL
          </Text>

          <View style={{
            flexDirection: 'row', gap: space.xl, marginTop: space.lg,
            paddingTop: space.lg, borderTopWidth: 1, borderTopColor: color.border,
            alignSelf: 'stretch', justifyContent: 'center',
          }}>
            {([['Protein', r.displayProtein], ['Carbs', r.displayCarbs], ['Fat', r.displayFat]] as const)
              .map(([label, value]) => (
                <View key={label} style={{ alignItems: 'center' }}>
                  <Text style={{ color: color.textPrimary, fontSize: type.metric.size, fontWeight: '600' }}>
                    {value}
                  </Text>
                  <Text style={{ color: color.textMuted, fontSize: type.caption.size }}>{label}</Text>
                </View>
              ))}
          </View>
        </Surface>
      </View>

      <View style={{ gap: space.md, paddingBottom: space.xxl }}>
        <PrimaryAction
          label="Log food"
          accessibilityLabel={`Log ${r.displayName}, ${r.displayGrams}, ${r.displayKcal} calories`}
          onPress={actions.onLog}
        />
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <SecondaryAction label="Change weight" accessibilityLabel="Change weight" onPress={actions.onChangeWeight} />
          </View>
          <View style={{ flex: 1 }}>
            <SecondaryAction label="Change food" accessibilityLabel="Change food" onPress={actions.onChangeFood} />
          </View>
        </View>
        <SecondaryAction
          label="Cancel"
          accessibilityLabel="Cancel without logging"
          tone="quiet"
          onPress={actions.onCancel}
        />
      </View>
    </View>
  );
}

/**
 * LOGGED — a brief appliance confirmation, never a modal workflow.
 *
 * The return home is driven by the action adapter, not by this component: the
 * UI confirms, the application decides.
 */
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
