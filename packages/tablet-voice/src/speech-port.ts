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

export interface SpeechPort {
  isAvailable(): Promise<boolean>;
  startListening(): void;
  stopListening(): void;
  /** Speaks trusted, already-rendered application text. Never provider output. */
  speak(text: string): void;
  stopSpeaking(): void;
  onResult(handler: (transcript: string) => void): () => void;
  onStateChange(handler: (state: 'listening' | 'idle') => void): () => void;
  onError(handler: (reason: SpeechFailure) => void): () => void;
}

/** Used when the device has no speech support; the UI stays fully usable. */
export const UNAVAILABLE_SPEECH: SpeechPort = {
  isAvailable: () => Promise.resolve(false),
  startListening: () => undefined,
  stopListening: () => undefined,
  speak: () => undefined,
  stopSpeaking: () => undefined,
  onResult: () => () => undefined,
  onStateChange: () => () => undefined,
  onError: () => () => undefined,
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
