import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  color, space, type, type TabletViewModel,
} from '@macros/tablet-view-model';
import { PrimaryAction, SecondaryAction, Surface } from './primitives.js';
import { EnergyBalanceHero } from './EnergyBalanceHero.js';
import { MacroProgress } from './MacroProgress.js';
import { VoiceStateIndicator } from './VoiceStateIndicator.js';
import { ScaleWeightDisplay } from './ScaleWeightDisplay.js';
import { FoodOptionCard } from './FoodOptionCard.js';
import { OfflineStatus, RecentFoodRow, TopIdentityBar } from './status.js';

export interface ScreenActions {
  readonly onAddFood: () => void;
  readonly onSelectOption: (productVersionId: string) => void;
  readonly onUseWeight: () => void;
  readonly onLog: () => void;
  readonly onChangeFood: () => void;
  readonly onChangeWeight: () => void;
  readonly onCancel: () => void;
  readonly onSelectMember: () => void;
}

/**
 * LOCKED / NEUTRAL.
 *
 * Rendered from `lockedViewModel()`, which is built without touching app state
 * at all — so there is no field of the previous occupant's day available to
 * leak, even by mistake.
 */
export function LockedHouseholdScreen(
  { onSelectMember }: { onSelectMember: () => void },
): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
      <Text style={{ color: color.textPrimary, fontSize: type.display.size, fontWeight: '600' }}>
        MACROS.AI
      </Text>
      <Text style={{
        color: color.textSecondary, fontSize: type.body.size,
        marginTop: space.md, marginBottom: space.xxl, textAlign: 'center',
      }}>
        Choose who's cooking
      </Text>
      <PrimaryAction
        label="Select member"
        accessibilityLabel="Select a household member to sign in"
        onPress={onSelectMember}
      />
    </View>
  );
}

export function HomeScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
      {vm.energy !== null ? <EnergyBalanceHero energy={vm.energy} /> : null}

      <View style={{ flexDirection: 'row' }}>
        {vm.macros.map((m) => <MacroProgress key={m.label} macro={m} />)}
      </View>

      <PrimaryAction
        label="Add food"
        accessibilityLabel="Add food"
        onPress={actions.onAddFood}
        disabled={!vm.offline.canLog}
      />

      {vm.recent.length > 0 ? (
        <Surface>
          <Text style={{ color: color.textSecondary, fontSize: type.label.size, marginBottom: space.sm }}>
            Today
          </Text>
          {vm.recent.map((r, i) => (
            <RecentFoodRow key={`${r.displayName}-${i}`} name={r.displayName} kcal={r.kcal} />
          ))}
        </Surface>
      ) : null}
    </ScrollView>
  );
}

export function FoodOptionsScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl }}>
      <Text style={{ color: color.textPrimary, fontSize: type.title.size, marginBottom: space.lg }}>
        Which one?
      </Text>
      {vm.options.map((o) => (
        <FoodOptionCard key={o.productVersionId} option={o} onSelect={actions.onSelectOption} />
      ))}
      <SecondaryAction label="Cancel" accessibilityLabel="Cancel adding food" onPress={actions.onCancel} />
    </ScrollView>
  );
}

export function WeighingScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const name = vm.review?.displayName ?? 'Selected food';
  return (
    <View style={{ flex: 1, padding: space.xl, justifyContent: 'space-between' }}>
      <ScaleWeightDisplay scale={vm.scale} foodName={name} />
      <View style={{ gap: space.md }}>
        <PrimaryAction
          label="Use this weight"
          accessibilityLabel="Use this weight"
          // Only a settled candidate may be committed.
          disabled={!vm.scale.canCommitWeight}
          onPress={actions.onUseWeight}
        />
        <SecondaryAction label="Change food" accessibilityLabel="Change food" onPress={actions.onChangeFood} />
      </View>
    </View>
  );
}

export function ReviewScreen(
  { vm, actions }: { vm: TabletViewModel; actions: ScreenActions },
): React.JSX.Element {
  const r = vm.review;
  if (r === null) return <View />;
  return (
    <View style={{ flex: 1, padding: space.xl, justifyContent: 'space-between' }}>
      <Surface>
        <Text style={{ color: color.textPrimary, fontSize: type.title.size }}>{r.displayName}</Text>
        {r.brand !== null ? (
          <Text style={{ color: color.textSecondary, fontSize: type.body.size }}>{r.brand}</Text>
        ) : null}
        <Text style={{ color: color.textMuted, fontSize: type.caption.size }}>{r.preparationState}</Text>

        <Text style={{
          color: color.textPrimary, fontSize: type.display.size,
          fontWeight: '600', marginTop: space.lg,
        }}>
          {r.grams} g
        </Text>
        <Text style={{ color: color.accent, fontSize: type.display.size, fontWeight: '600' }}>
          {r.kcal} kcal
        </Text>
        <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.sm }}>
          {r.proteinG} g protein · {r.carbohydrateG} g carbs · {r.fatG} g fat
        </Text>
      </Surface>

      <View style={{ gap: space.md }}>
        <PrimaryAction
          label="Log"
          accessibilityLabel={`Log ${r.displayName}, ${r.grams} grams, ${r.kcal} calories`}
          onPress={actions.onLog}
        />
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <SecondaryAction label="Change food" accessibilityLabel="Change food" onPress={actions.onChangeFood} />
          </View>
          <View style={{ flex: 1 }}>
            <SecondaryAction label="Change weight" accessibilityLabel="Change weight" onPress={actions.onChangeWeight} />
          </View>
        </View>
        <SecondaryAction label="Cancel" accessibilityLabel="Cancel without logging" onPress={actions.onCancel} />
      </View>
    </View>
  );
}

/** Brief confirmation. The user is never trapped here. */
export function LoggedScreen({ vm }: { vm: TabletViewModel }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLiveRegion="assertive"
      accessibilityLabel={vm.offline.offline ? 'Logged. Waiting to sync.' : 'Logged'}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: color.accent, fontSize: type.hero.size, fontWeight: '700' }}>
        Logged
      </Text>
      {vm.offline.offline ? (
        <Text style={{ color: color.textSecondary, fontSize: type.body.size, marginTop: space.md }}>
          Waiting to sync
        </Text>
      ) : null}
    </View>
  );
}

/** Root shell: identity, voice presence, offline status, then the screen. */
/**
 * Permanent banner for a development build.
 *
 * Deliberately impossible to miss: a fixture host must never be mistaken for
 * real persistence or a real account.
 */
function DevelopmentBanner({ notice }: { notice: string }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={notice}
      style={{ backgroundColor: color.warning, paddingVertical: space.sm, alignItems: 'center' }}
    >
      <Text style={{ color: color.surfaceBase, fontSize: type.caption.size, fontWeight: '600' }}>
        {notice}
      </Text>
    </View>
  );
}

export function TabletShell(
  { vm, actions, developmentNotice = null }:
  { vm: TabletViewModel; actions: ScreenActions; developmentNotice?: string | null },
): React.JSX.Element {
  if (vm.screen === 'locked' || vm.identity === null) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surfaceBase }}>
        {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}
        <LockedHouseholdScreen onSelectMember={actions.onSelectMember} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.surfaceBase }}>
      {developmentNotice !== null ? <DevelopmentBanner notice={developmentNotice} /> : null}
      <TopIdentityBar identity={vm.identity}>
        <VoiceStateIndicator presence={vm.voice} />
      </TopIdentityBar>

      <View style={{ paddingHorizontal: space.xl }}>
        <OfflineStatus offline={vm.offline} />
      </View>

      <View style={{ flex: 1 }}>
        {vm.screen === 'home' ? <HomeScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'food_options' ? <FoodOptionsScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'weighing' ? <WeighingScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'review' ? <ReviewScreen vm={vm} actions={actions} /> : null}
        {vm.screen === 'logged' ? <LoggedScreen vm={vm} /> : null}
      </View>

      {vm.error !== null ? (
        <View style={{ padding: space.xl }}>
          <Text style={{ color: color.danger, fontSize: type.body.size }}>{vm.error.message}</Text>
        </View>
      ) : null}
    </View>
  );
}
