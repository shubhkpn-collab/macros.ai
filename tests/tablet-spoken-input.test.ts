import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lockedViewModel, type TabletViewModel } from '@macros/tablet-view-model';
import { UNAVAILABLE_SPEECH } from '@macros/tablet-voice';
const coordinatorModule = await import('../apps/tablet/src/voice/voice-coordinator.js');
const VoiceCoordinator = coordinatorModule.VoiceCoordinator ?? (coordinatorModule as unknown as { default: typeof coordinatorModule }).default.VoiceCoordinator;
import type { TabletActions } from '../apps/tablet/src/actions.js';

function harness() {
  let vm: TabletViewModel = { ...lockedViewModel(), screen: 'home' };
  const calls: unknown[] = [];
  const actions: TabletActions = {
    onAddFood: () => { calls.push('add'); vm = { ...vm, screen: 'food_search' }; },
    onSearchFood: query => calls.push(['search', query]),
    onSelectOption: id => calls.push(['select', id]),
    onChooseGuidanceCandidate: (id, envelope) => calls.push(['guidance', id, envelope]),
    onEnterManualWeight: grams => calls.push(['weight', grams]),
    onUseWeight: () => calls.push('scale'),
    onLog: () => calls.push('log'),
    onChangeWeight: () => calls.push('edit'),
    onCancel: () => calls.push('cancel'),
    onChangeFood: () => calls.push('change'),
    onRequestGuidance: () => calls.push('ask'),
    onSelectMember: () => calls.push('member'),
    onSaveGoal: async () => false,
  };
  const voice = new VoiceCoordinator({ speech: UNAVAILABLE_SPEECH, actions, viewModel: () => vm });
  return { voice, calls, set: (next: Partial<TabletViewModel>) => { vm = { ...vm, ...next }; } };
}

describe('Tablet spoken input is bounded by the visible flow', () => {
  test('search opens the flow before submitting the spoken query', () => {
    const h = harness();
    h.voice.handleTranscript('Hey Macros, search for tofu');
    assert.deepEqual(h.calls, ['add', ['search', 'tofu']]);
    h.set({ screen: 'review' });
    h.voice.handleTranscript('search for bread');
    assert.equal(h.calls.length, 2);
  });
  test('an ordinal chooses a visible catalog result, never an old suggestion', () => {
    const h = harness();
    h.set({ screen: 'food_options', options: [{ productVersionId: 'visible@v1', optionLabel: 'A', displayName: 'Tofu', brand: null, preparationState: 'ready', preparationMatters: false }] });
    h.voice.handleTranscript('option one');
    h.voice.handleTranscript('option two');
    assert.deepEqual(h.calls, [['select', 'visible@v1']]);
  });
  test('dictated weight and confirmation are separate and require their own screens', () => {
    const h = harness();
    h.voice.handleTranscript('94.5 grams');
    h.voice.handleTranscript('confirm');
    assert.deepEqual(h.calls, []);
    h.set({ screen: 'weighing' });
    h.voice.handleTranscript('94.5 grams');
    h.voice.handleTranscript('confirm');
    assert.deepEqual(h.calls, [['weight', 94.5]]);
    h.set({ screen: 'review' });
    h.voice.handleTranscript('confirm');
    assert.deepEqual(h.calls, [['weight', 94.5], 'log']);
  });
  test('voice never captures an unsettled scale', () => {
    const h = harness();
    h.set({ screen: 'weighing' });
    h.voice.handleTranscript('use scale weight');
    assert.deepEqual(h.calls, []);
    h.set({ scale: { ...lockedViewModel().scale, canCommitWeight: true } });
    h.voice.handleTranscript('use scale weight');
    assert.deepEqual(h.calls, ['scale']);
  });
});
