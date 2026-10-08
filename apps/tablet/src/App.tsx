import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, SafeAreaView, StatusBar } from 'react-native';
import { color } from '@macros/tablet-view-model';
import { TabletShell } from './components/screens.js';
import type { GuidanceDeps } from '@macros/tablet-app-core';
import type { PremiumSpeechTransport } from '@macros/tablet-voice';
import { createActions, type AuthHostPort } from './actions.js';
import { createNativeSpeechPort } from './voice/native-speech.js';
import { KitchenConversation } from './voice/kitchen-realtime.js';
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
  {
    composition, auth, hasActiveSession, developmentNotice = null, guidance,
    premiumSpeech,
  }:
  {
    composition: TabletComposition; auth: AuthHostPort;
    hasActiveSession: boolean; developmentNotice?: string | null;
    guidance?: GuidanceDeps;
    premiumSpeech?: PremiumSpeechTransport;
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

  const [conversationActive, setConversationActive] = useState(false);
  const [conversationStatus, setConversationStatus] = useState<string | null>(null);
  const conversation = useMemo(() => new KitchenConversation(
    () => renderModel(composition, hasActiveSession),
    (text, active) => { setConversationStatus(text); setConversationActive(active); },
  ), [composition, hasActiveSession]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state !== 'active') conversation.stop(); });
    return () => { sub.remove(); conversation.stop(); };
  }, [conversation]);

  const [listening, setListening] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  // Smoothed microphone amplitude for the orb waveform, 0–1.
  const [level, setLevel] = useState(0);
  // Increments once per wake acknowledgement; the orb pulses on change.
  const [wakePulse, setWakePulse] = useState(0);

  /**
   * ONE coordinator for the app's life, not one per render. A new instance on
   * every render would lose the spoken-once guard and re-announce the same
   * recommendation each time the screen updated.
   */
  const voice = useMemo(() => new VoiceCoordinator({
    speech: createNativeSpeechPort(),
    actions,
    viewModel: () => viewModelRef.current,
    ...(premiumSpeech !== undefined ? { premium: premiumSpeech } : {}),
  }), [actions, premiumSpeech]);

  /**
   * Every path that ends listening returns the orb to idle: a final result,
   * end-of-speech, an error, a denied permission, or no speech service at all.
   * A stuck listening state would be the most visible possible failure in a
   * demo, so it is reset from all of them rather than from the happy path.
   */
  useEffect(() => {
    const offResult = voice.speechPort.onResult((t) => {
      setVoiceFeedback(null);
      setListening(false);
      setLevel(0);
      voice.handleTranscript(t);
      refresh();
    });
    const offState = voice.speechPort.onStateChange((state) => {
      setListening(state === 'listening');
      refresh();
    });
    // A speech failure is never surfaced raw; the touch path simply remains.
    const offError = voice.speechPort.onError((reason) => {
      setVoiceFeedback(reason === 'no_speech' ? 'No speech heard. Tap the microphone and try again.' : reason === 'network' ? 'Speech recognition needs a connection. Check the tablet network and try again.' : reason === 'permission_denied' ? 'Microphone permission is needed for voice commands.' : 'Android speech recognition is unavailable. Touch controls still work.');
      setListening(false);
      voice.handleRecognitionEnded();
      voice.markSpeechFinished(null);
      refresh();
    });
    // Ends, interruptions and playback failures all land here, so the orb
    // always comes to rest.
    const offDone = voice.speechPort.onSpeechFinished((speechId) => {
      voice.markSpeechFinished(speechId);
      refresh();
    });
    // The orb lights only when audio is genuinely audible.
    const offStart = voice.speechPort.onPlaybackStart((speechId) => {
      voice.handlePlaybackStart(speechId);
      refresh();
    });
    // Premium playback failed; the appliance speaks in its own voice, once.
    const offPremium = voice.speechPort.onPremiumFailure((speechId) => {
      voice.handlePremiumFailure(speechId);
      refresh();
    });
    // Amplitude drives the waveform. Nothing is stored.
    const offLevel = voice.speechPort.onLevel((rmsDb) => {
      setLevel(voice.handleLevel(rmsDb));
    });
    // "Hey Macros" heard: one acknowledging pulse. Recognition continues, and
    // no partial ever reaches the provider.
    const offPartial = voice.speechPort.onPartial((transcript) => {
      if (voice.handlePartial(transcript)) setWakePulse((n) => n + 1);
    });
    return () => {
      offResult(); offState(); offError(); offDone();
      offStart(); offPremium(); offLevel(); offPartial();
    };
  }, [voice, refresh]);

  // Stop audio and refuse late callbacks when the host goes away, so nothing
  // speaks into a screen that no longer exists.
  useEffect(() => () => { voice.dispose(); }, [voice]);

  /**
   * Speak a completed answer exactly once.
   *
   * `envelopeId` MUST be a dependency: the coordinator keys speech on it, and a
   * second question can legitimately return the same sentence in the same
   * phase. Watching only text and phase meant React never re-invoked this, so
   * the second recommendation of the demo would have been silent while the
   * coordinator sat ready to speak it.
   */
  useEffect(() => {
    if (!conversationActive) voice.speakGuidanceIfNew();
  }, [voice, vm.guidance.envelopeId, vm.guidance.text, vm.guidance.phase, conversationActive]);

  /**
   * Screen-facing actions: the shared set plus push-to-talk. Defined after the
   * coordinator exists so the orb is never a dead control.
   */
  const screenActions = useMemo(() => ({
    ...actions,
    voiceFeedback: conversationActive ? conversationStatus : voiceFeedback ?? conversationStatus,
    conversationActive,
    onConversation: () => {
      if (conversationActive) conversation.stop();
      else { voice.speechPort.stopListening(); voice.speechPort.stopSpeaking(); setListening(false); void conversation.start(); }
    },
    onOrbPress: () => {
      // The outcome is authoritative: a refusal settles the orb immediately
      // instead of leaving it on "Listening…" for an event that never comes.
      conversation.stop();
      setVoiceFeedback(null);
      void voice.toggleListening().then((outcome) => {
        setListening(outcome === 'started');
        if (outcome === 'refused') Alert.alert('Voice unavailable', 'Android speech recognition is unavailable or microphone access was denied. You can still search and log food using the touch controls.');
        refresh();
      });
    },
    isListening: listening,
    isSpeaking: voice.isSpeaking(),
    micLevel: level,
    wakePulse,
  }), [actions, voice, listening, level, wakePulse, tick, voiceFeedback, conversation, conversationActive, conversationStatus]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.canvas }}>
      <StatusBar barStyle="light-content" backgroundColor={color.canvas} />
      <TabletShell vm={vm} actions={screenActions} developmentNotice={developmentNotice} />
    </SafeAreaView>
  );
}
