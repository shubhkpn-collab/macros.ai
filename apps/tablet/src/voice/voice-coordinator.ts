import type { TabletViewModel } from '@macros/tablet-view-model';
import type { TabletActions } from '../actions.js';
import {
  SpokenOnce, interpretVoiceCommand, type SpeechPort,
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
  readonly actions: TabletActions;
  viewModel(): TabletViewModel;
}

export class VoiceCoordinator {
  private readonly spoken = new SpokenOnce();
  private listening = false;

  constructor(private readonly deps: VoiceCoordinatorDeps) {}

  /** Exposed so the host can subscribe once and clean up on unmount. */
  get speechPort(): SpeechPort { return this.deps.speech; }

  isListening(): boolean { return this.listening; }

  /** Push-to-talk. Listening always interrupts whatever MACROS is saying. */
  toggleListening(): void {
    if (this.listening) {
      this.deps.speech.stopListening();
      this.listening = false;
      return;
    }
    this.deps.speech.stopSpeaking();
    this.listening = true;
    this.deps.speech.startListening();
  }

  /** Route a final transcript. Nothing here decides nutrition or food. */
  handleTranscript(transcript: string): void {
    this.listening = false;
    const vm = this.deps.viewModel();
    const candidates = vm.guidance.candidates;
    const intent = interpretVoiceCommand(transcript, candidates.length);

    switch (intent.kind) {
      case 'request_guidance':
        // THE existing intent — the same one the button calls.
        this.deps.actions.onRequestGuidance();
        return;
      case 'choose_option': {
        const chosen = candidates[intent.index];
        if (chosen === undefined || vm.guidance.envelopeId === null) return;
        this.deps.actions.onChooseGuidanceCandidate(
          chosen.productVersionId, vm.guidance.envelopeId);
        return;
      }
      case 'log':
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
    this.deps.speech.speak(text);
  }

  reset(): void { this.spoken.reset(); }
}
