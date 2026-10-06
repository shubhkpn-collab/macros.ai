import type { TabletViewModel } from '@macros/tablet-view-model';
import type { TabletActions } from '../actions.js';
import {
  LevelSmoother, SpeechAttempt, SpokenOnce, containsWakePhrase,
  interpretVoiceCommand, normalizeRms,
  type PremiumSpeechTransport, type SpeechPort,
} from '@macros/tablet-voice';

/**
 * VOICE COORDINATION.
 *
 * Joins the speech port to intents the touch flow already exposes. Every spoken
 * command lands on the SAME application intent as its button — there is no
 * voice-only path, so the two cannot drift.
 *
 * In particular "what should I eat" calls requestFoodGuidance(), not the older
 * deterministic recommendFood(): routing voice to the legacy path would bypass
 * the guidance and provider flow entirely.
 */
export const VOICE_COORDINATOR_VERSION = 'voice-coordinator@1.0.0';

export interface VoiceCoordinatorDeps {
  readonly speech: SpeechPort;
  /** Absent means native speech only — a perfectly good demo, just less warm. */
  readonly premium?: PremiumSpeechTransport;
  readonly actions: TabletActions;
  viewModel(): TabletViewModel;
}

export class VoiceCoordinator {
  private readonly spoken = new SpokenOnce();
  private readonly levels = new LevelSmoother();
  private listening = false;
  private speaking = false;
  /** Per-utterance tier bookkeeping. Replaced whenever new guidance arrives. */
  private attempt = new SpeechAttempt();
  private level = 0;
  /**
   * Identity of the utterance that currently owns the output path.
   *
   * Native events carry the id they were created with, so a delayed completion
   * or failure from a replaced utterance can be recognised and ignored rather
   * than mutating the new one. Timing cannot distinguish them.
   */
  private speechId: string | null = null;
  private speechSequence = 0;
  /**
   * False once the host unmounts.
   *
   * A premium request in flight resolves on its own schedule. Without this, a
   * response arriving after the screen was torn down would still call into the
   * native player and produce audio with no interface behind it.
   */
  private active = true;
  /** At most one wake acknowledgement per listening session. */
  private wakeAcknowledged = false;

  constructor(private readonly deps: VoiceCoordinatorDeps) {}

  /** Exposed so the host can subscribe once and clean up on unmount. */
  get speechPort(): SpeechPort { return this.deps.speech; }

  isListening(): boolean { return this.listening; }

  isSpeaking(): boolean { return this.speaking; }

  /** Smoothed microphone amplitude, 0–1. Nothing is retained between sessions. */
  currentLevel(): number { return this.level; }

  /**
   * A partial transcript arrived.
   *
   * Returns true exactly once per session, when the wake phrase first appears,
   * so the orb can give a single acknowledging pulse. Recognition is NOT
   * stopped and no request is sent — partials never drive application intents,
   * only this one visual beat.
   */
  handlePartial(transcript: string): boolean {
    if (!this.listening || this.wakeAcknowledged) return false;
    if (!containsWakePhrase(transcript)) return false;
    this.wakeAcknowledged = true;
    return true;
  }

  /** Called from the native RMS event while listening. */
  handleLevel(rmsDb: number): number {
    if (!this.listening) return 0;
    this.level = this.levels.push(normalizeRms(rmsDb));
    return this.level;
  }

  /** Push-to-talk. Listening always interrupts whatever MACROS is saying. */
  /**
   * Push-to-talk.
   *
   * Returns the outcome so the caller can settle the UI. Listening is only
   * marked true once the recogniser actually started: an optimistic flag left
   * the orb stuck on "Listening…" when permission was denied, because no event
   * could ever arrive to correct it.
   */
  async toggleListening(): Promise<'started' | 'stopped' | 'refused'> {
    if (this.listening) {
      this.deps.speech.stopListening();
      this.listening = false;
      return 'stopped';
    }
    // Interrupting a real assistant: audio stops, the microphone opens.
    this.deps.speech.stopSpeaking();
    this.speaking = false;
    // Not yet listening: that is only true once the recogniser confirms.
    this.speechId = null;
    /**
     * EVERY session starts unacknowledged. The final-result and error paths
     * also reset this, but a user who stops listening manually reaches neither
     * — and would then never see the pulse again.
     */
    this.wakeAcknowledged = false;
    this.levels.reset();
    this.level = 0;

    const outcome = await this.deps.speech.startListening();
    if (outcome !== 'started') {
      // Denied permission or no recogniser: settle immediately rather than
      // waiting for an event that can never arrive. Touch stays usable.
      this.listening = false;
      this.levels.reset();
      this.level = 0;
      return 'refused';
    }
    this.listening = true;
    return 'started';
  }

  /** Route a final transcript. Nothing here decides nutrition or food. */
  handleTranscript(transcript: string): void {
    this.listening = false;
    // The session is over: the waveform settles and the next session may
    // acknowledge again.
    this.wakeAcknowledged = false;
    this.levels.reset();
    this.level = 0;
    const vm = this.deps.viewModel();
    const options = vm.screen === 'food_options' || vm.screen === 'weighing' ? vm.options : [];
    const candidates = vm.screen === 'home' ? vm.guidance.candidates : [];
    const intent = interpretVoiceCommand(transcript, options.length || candidates.length);

    switch (intent.kind) {
      case 'search_food':
        if (vm.screen === 'home') this.deps.actions.onAddFood();
        else if (vm.screen !== 'food_search') return;
        this.deps.actions.onSearchFood(intent.query);
        return;
      case 'manual_weight':
        if (vm.screen === 'weighing') this.deps.actions.onEnterManualWeight(intent.grams);
        return;
      case 'use_weight':
        if (vm.screen === 'weighing' && vm.scale.canCommitWeight) this.deps.actions.onUseWeight();
        return;
      case 'change_weight':
        if (vm.screen === 'review') this.deps.actions.onChangeWeight();
        return;
      case 'request_guidance':
        if (vm.screen !== 'home') return;
        // THE existing intent — the same one the button calls.
        this.deps.actions.onRequestGuidance();
        return;
      case 'choose_option': {
        const option = options[intent.index];
        if (option !== undefined) { this.deps.actions.onSelectOption(option.productVersionId); return; }
        const chosen = candidates[intent.index];
        if (chosen === undefined || vm.guidance.envelopeId === null) return;
        this.deps.actions.onChooseGuidanceCandidate(
          chosen.productVersionId, vm.guidance.envelopeId);
        return;
      }
      case 'log':
        if (vm.screen !== 'review') return;
        this.deps.actions.onLog();
        return;
      case 'cancel':
        this.deps.speech.stopSpeaking();
        this.deps.actions.onCancel();
        return;
      default:
        // Unrecognized: say nothing and change nothing. Acting on a
        // half-understood phrase is worse than waiting to be asked again.
        return;
    }
  }

  /**
   * Speak a completed guidance outcome, at most once.
   *
   * Only `vm.guidance.text` is spoken — text the application rendered from a
   * validated template. Provider output, rejection reasons and error details
   * never reach the speaker.
   */
  speakGuidanceIfNew(): void {
    const vm = this.deps.viewModel();
    const text = vm.guidance.text;
    if (text.length === 0) return;
    const key = `${vm.guidance.envelopeId ?? 'none'}:${vm.guidance.phase}`;
    if (!this.spoken.shouldSpeak(key)) return;

    /**
     * A NEW utterance, so a fresh attempt: whatever the previous one did must
     * not stop this one speaking, and stale audio is cancelled outright.
     */
    const attempt = new SpeechAttempt();
    this.attempt = attempt;
    this.speechSequence += 1;
    const speechId = `utt-${String(this.speechSequence)}`;
    this.speechId = speechId;
    this.deps.speech.stopSpeaking();
    /**
     * SPEAKING IS NOT SET HERE.
     *
     * The contract is that SPEAKING means audio is audible. Setting it before
     * the request lit the orb during the server round trip, generation,
     * download and MediaPlayer preparation — while the room was silent. The
     * premium path becomes SPEAKING only on handlePlaybackStart(); the native
     * path sets it as it speaks, because native TTS is audible immediately.
     */
    /**
     * Set BEFORE any asynchronous work: a very fast failure would otherwise
     * outrun the assignment and find no text to fall back with.
     */
    this.pendingText = text;

    const premium = this.deps.premium;
    if (premium === undefined || !attempt.claimPremiumRequest()) {
      this.speakNatively(text);
      return;
    }

    void premium.requestAudio(text).then((outcome) => {
      // Torn down, or a newer utterance replaced this one: either way the audio
      // is stale and must not reach the player.
      if (!this.active || this.attempt !== attempt) return;
      if (outcome.ok) {
        /**
         * Bytes arrived — NOT audible yet. Premium is only marked audible when
         * Android reports playback actually started, or a MediaPlayer failure
         * could never fall back.
         */
        this.deps.speech.playAudio(
          outcome.audio.audioBase64, outcome.audio.mimeType, speechId);
        return;
      }
      // No key, timeout, bad payload: fall back once.
      this.failPremium(attempt, text);
    }).catch(() => { this.failPremium(attempt, text); });
  }

  /** Text of the utterance in flight, so a late premium failure can fall back. */
  private pendingText: string | null = null;

  /**
   * Speak in the appliance's own voice, at most once per utterance.
   *
   * Refused outright if premium audio is already playing: two voices at once is
   * the worst outcome of the whole chain, worse than silence.
   */
  private speakNatively(text: string): void {
    if (!this.active) return;
    if (!this.attempt.claimNativeSpeech()) return;
    this.speaking = true;
    this.deps.speech.speak(text, this.speechId ?? 'utt-0');
  }

  /**
   * Premium could not be produced or played, for THIS utterance.
   *
   * Scoped to the attempt so a stale failure from a replaced utterance cannot
   * speak text the user has moved on from.
   */
  private failPremium(attempt: SpeechAttempt, text: string): void {
    if (this.attempt !== attempt) return;
    attempt.markPremiumFailed();
    this.speakNatively(text);
  }

  /** Premium playback could not start, or stopped mid-way. */
  handlePremiumFailure(speechId: string | null): void {
    // A failure belonging to a replaced utterance must not speak old text.
    if (speechId !== null && speechId !== this.speechId) return;
    const text = this.pendingText;
    if (text === null) return;
    this.failPremium(this.attempt, text);
  }

  /**
   * Android reports audio is genuinely audible. Only now is the orb lit and the
   * native tier blocked.
   */
  handlePlaybackStart(speechId: string | null): void {
    // A start belonging to a replaced utterance must not light the orb.
    if (speechId !== null && speechId !== this.speechId) return;
    this.attempt.markPremiumAudible();
    this.speaking = true;
  }

  /** Audio finished or failed. Either way the orb must come to rest. */
  markSpeechFinished(speechId: string | null = null): void {
    // A completion belonging to a replaced utterance must not stop the new one.
    if (speechId !== null && speechId !== this.speechId) return;
    this.speaking = false;
    this.pendingText = null;
  }

  /** Recognition failed or was cancelled: the session ends without a result. */
  handleRecognitionEnded(): void {
    this.listening = false;
    this.wakeAcknowledged = false;
    this.levels.reset();
    this.level = 0;
  }

  /**
   * Release the coordinator when its host goes away.
   *
   * Stops any audio and refuses later callbacks, so nothing speaks into a
   * screen that no longer exists.
   */
  dispose(): void {
    this.active = false;
    this.listening = false;
    this.speaking = false;
    this.pendingText = null;
    this.deps.speech.stopSpeaking();
  }

  reset(): void {
    this.spoken.reset();
    this.wakeAcknowledged = false;
    this.speaking = false;
    this.attempt = new SpeechAttempt();
    this.pendingText = null;
    this.levels.reset();
    this.level = 0;
    // A new session earns a new acknowledgement.
    this.wakeAcknowledged = false;
  }
}
