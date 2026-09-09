/**
 * SPEECH PORT.
 *
 * The application's view of the microphone and the speaker. The native module
 * is one implementation; a test supplies another. Nothing above this layer
 * knows which is present, so a device without speech degrades to touch rather
 * than breaking.
 */
export const SPEECH_PORT_VERSION = 'speech-port@1.0.0';

export type SpeechFailure = 'permission_denied' | 'no_speech' | 'network' | 'unavailable';

/**
 * Whether listening actually began.
 *
 * Returned rather than assumed: an optimistic boolean left the orb stuck on
 * "Listening…" forever when permission was denied or no recogniser existed,
 * because no native event could ever arrive to correct it.
 */
export type ListeningStart = 'started' | 'permission_denied' | 'unavailable';

export interface SpeechPort {
  isAvailable(): Promise<boolean>;
  startListening(): Promise<ListeningStart>;
  stopListening(): void;
  /** Speaks trusted, already-rendered application text. Never provider output. */
  speak(text: string, speechId: string): void;
  stopSpeaking(): void;
  onResult(handler: (transcript: string) => void): () => void;
  onStateChange(handler: (state: 'listening' | 'idle') => void): () => void;
  onError(handler: (reason: SpeechFailure) => void): () => void;
  /** Fires when an utterance ends, is interrupted, or fails to play. */
  onSpeechFinished(handler: (speechId: string | null) => void): () => void;
  /** Plays premium audio. `speechId` identifies the utterance in every event. */
  playAudio(audioBase64: string, mimeType: string, speechId: string): void;
  /** Fires when premium playback could not start or failed mid-way. */
  onPremiumFailure(handler: (speechId: string | null) => void): () => void;
  /** Fires when audio is genuinely audible, so the orb lights only then. */
  onPlaybackStart(handler: (speechId: string | null) => void): () => void;
  /** Normalized microphone amplitude while listening. Never stored. */
  onLevel(handler: (rmsDb: number) => void): () => void;
  onPartial(handler: (transcript: string) => void): () => void;
}

/** Used when the device has no speech support; the UI stays fully usable. */
export const UNAVAILABLE_SPEECH: SpeechPort = {
  isAvailable: () => Promise.resolve(false),
  // Reports honestly rather than leaving the caller waiting for an event.
  startListening: () => Promise.resolve('unavailable' as ListeningStart),
  stopListening: () => undefined,
  speak: () => undefined,
  stopSpeaking: () => undefined,
  onResult: () => () => undefined,
  onStateChange: () => () => undefined,
  onError: () => () => undefined,
  onSpeechFinished: () => () => undefined,
  playAudio: () => undefined,
  onPremiumFailure: () => () => undefined,
  onPlaybackStart: () => () => undefined,
  onLevel: () => () => undefined,
  onPartial: () => () => undefined,
};

/**
 * Guard against repeated speech.
 *
 * React re-renders whenever state changes, and a guidance outcome that speaks
 * on render would repeat itself every time the screen updated. Speaking is
 * keyed to the outcome's identity, so one answer is spoken once.
 */
export class SpokenOnce {
  private lastSpokenKey: string | null = null;

  shouldSpeak(key: string | null): boolean {
    if (key === null || key === this.lastSpokenKey) return false;
    this.lastSpokenKey = key;
    return true;
  }

  reset(): void { this.lastSpokenKey = null; }
}
