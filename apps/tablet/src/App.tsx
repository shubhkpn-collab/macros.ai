import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, StatusBar } from 'react-native';
import { color } from '@macros/tablet-view-model';
import { TabletShell } from './components/screens.js';
import type { GuidanceDeps } from '@macros/tablet-app-core';
import { createActions, type AuthHostPort } from './actions.js';
import { createNativeSpeechPort } from './voice/native-speech.js';
import { VoiceCoordinator } from './voice/voice-coordinator.js';
import { renderModel, type TabletComposition } from './composition.js';

/**
 * Root component.
 *
 * It owns no domain state: after every interaction it re-projects the view
 * model, so the screen is a projection of the application rather than a second
 * copy that could drift from it.
 */
export function App(
  { composition, auth, hasActiveSession, developmentNotice = null, guidance }:
  {
    composition: TabletComposition; auth: AuthHostPort;
    hasActiveSession: boolean; developmentNotice?: string | null;
    guidance?: GuidanceDeps;
  },
): React.JSX.Element {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const vm = useMemo(
    () => renderModel(composition, hasActiveSession),
    // `tick` re-projects after an interaction; it carries no data itself.
    [composition, hasActiveSession, tick],
  );

  const actions = useMemo(() => createActions({
    controller: composition.controller,
    ...(guidance !== undefined ? { guidance } : {}),
    auth,
    activity: () => composition.currentActivity(),
    onChanged: refresh,
  }), [composition, auth, guidance, refresh]);

  // The coordinator reads the CURRENT view model when a transcript arrives, so
  // a spoken choice always applies to what is on screen right now. Declared
  // BEFORE the coordinator that closes over it.
  const viewModelRef = useRef(vm);
  viewModelRef.current = vm;

  const [listening, setListening] = useState(false);

  /**
   * ONE coordinator for the app's life, not one per render. A new instance on
   * every render would lose the spoken-once guard and re-announce the same
   * recommendation each time the screen updated.
   */
  const voice = useMemo(() => new VoiceCoordinator({
    speech: createNativeSpeechPort(),
    actions,
    viewModel: () => viewModelRef.current,
  }), [actions]);

  /**
   * Every path that ends listening returns the orb to idle: a final result,
   * end-of-speech, an error, a denied permission, or no speech service at all.
   * A stuck listening state would be the most visible possible failure in a
   * demo, so it is reset from all of them rather than from the happy path.
   */
  useEffect(() => {
    const offResult = voice.speechPort.onResult((t) => {
      setListening(false);
      voice.handleTranscript(t);
      refresh();
    });
    const offState = voice.speechPort.onStateChange((state) => {
      setListening(state === 'listening');
      refresh();
    });
    // A speech failure is never surfaced raw; the touch path simply remains.
    const offError = voice.speechPort.onError(() => {
      setListening(false);
      refresh();
    });
    return () => { offResult(); offState(); offError(); };
  }, [voice, refresh]);

  // Speak a completed answer exactly once.
  useEffect(() => { voice.speakGuidanceIfNew(); }, [voice, vm.guidance.text, vm.guidance.phase]);

  /**
   * Screen-facing actions: the shared set plus push-to-talk. Defined after the
   * coordinator exists so the orb is never a dead control.
   */
  const screenActions = useMemo(() => ({
    ...actions,
    onOrbPress: () => {
      voice.toggleListening();
      // Optimistic, then corrected by the native start/end events. Waiting for
      // the event alone leaves the orb dead for the moment it takes the
      // recogniser to spin up.
      setListening(voice.isListening());
    },
    isListening: listening,
  }), [actions, voice, listening]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.canvas }}>
      <StatusBar barStyle="light-content" backgroundColor={color.canvas} />
      <TabletShell vm={vm} actions={screenActions} developmentNotice={developmentNotice} />
    </SafeAreaView>
  );
}
