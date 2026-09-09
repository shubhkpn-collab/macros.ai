/**
 * PREMIUM SPEECH CHAIN.
 *
 * Pure decision logic, kept out of the React Native adapter so the part that
 * matters most — that a sentence is spoken exactly once — can be tested
 * without a device.
 *
 * The rule the whole design serves: for one piece of trusted guidance, either
 * premium audio plays or native speech does. Never both, never twice.
 */
export const PREMIUM_SPEECH_VERSION = 'premium-speech@1.0.0';

export interface PremiumAudio {
  readonly mimeType: string;
  readonly audioBase64: string;
}

export type PremiumOutcome =
  | { readonly ok: true; readonly audio: PremiumAudio }
  | { readonly ok: false; readonly reason: PremiumFailure };

export type PremiumFailure =
  | 'unavailable' | 'http_error' | 'malformed' | 'empty_audio'
  | 'wrong_mime' | 'timeout' | 'playback_failed';

/** The transport the tablet uses to ask MACROS for audio. */
export interface PremiumSpeechTransport {
  requestAudio(text: string): Promise<PremiumOutcome>;
}

/**
 * Validate what came back over the wire.
 *
 * Every rejection here is a fallback, not an error: the appliance still speaks,
 * just in its own voice. Being strict costs nothing and stops a malformed
 * payload reaching the media player.
 */
export function decodeAudioResponse(raw: unknown): PremiumOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed' };
  }
  const o = raw as Record<string, unknown>;

  const mimeType = o['mimeType'];
  if (typeof mimeType !== 'string') return { ok: false, reason: 'malformed' };
  // Only what the native player is built to handle.
  if (mimeType !== 'audio/mpeg') return { ok: false, reason: 'wrong_mime' };

  const audioBase64 = o['audioBase64'];
  if (typeof audioBase64 !== 'string') return { ok: false, reason: 'malformed' };
  if (audioBase64.length === 0) return { ok: false, reason: 'empty_audio' };

  return { ok: true, audio: { mimeType, audioBase64 } };
}

/**
 * Tracks which tier spoke for the current utterance.
 *
 * Without this a React re-render, a late premium response, or a playback error
 * arriving after the fallback already ran would each produce a second voice.
 */
/**
 * Tracks which tier spoke for the current utterance.
 *
 * The distinction that matters: a successful HTTP response is NOT audible
 * audio. Marking premium as playing when the bytes arrived meant a later
 * MediaPlayer failure could not fall back — the native tier was blocked by a
 * sound nobody ever heard. Premium becomes audible only when Android says
 * playback actually started.
 */
export class SpeechAttempt {
  private premiumRequested = false;
  private premiumAudible = false;
  private premiumFailed = false;
  private nativeSpoken = false;

  /** True the first time only; a re-render must not buy a second request. */
  claimPremiumRequest(): boolean {
    if (this.premiumRequested) return false;
    this.premiumRequested = true;
    return true;
  }

  /**
   * Android reported that audio is genuinely playing. Only now can the native
   * tier be blocked, because only now is there something to collide with.
   */
  markPremiumAudible(): void {
    if (this.premiumFailed) return;
    this.premiumAudible = true;
  }

  /**
   * Premium could not be produced or could not be played.
   *
   * Recorded explicitly so a failure arriving AFTER playback began still
   * releases the native tier — a track that cut out halfway is a failure, and
   * the user should still hear the sentence.
   */
  markPremiumFailed(): void {
    this.premiumFailed = true;
    this.premiumAudible = false;
  }

  /**
   * True only if nothing has spoken and premium is not currently audible.
   * Two voices at once is the worst outcome of the chain, worse than silence.
   */
  claimNativeSpeech(): boolean {
    if (this.nativeSpoken) return false;
    if (this.premiumAudible) return false;
    this.nativeSpoken = true;
    return true;
  }

  get spokenByNative(): boolean { return this.nativeSpoken; }

  get playingPremium(): boolean { return this.premiumAudible; }

  get failed(): boolean { return this.premiumFailed; }
}
