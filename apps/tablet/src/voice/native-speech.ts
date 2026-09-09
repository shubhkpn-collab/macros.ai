import { NativeEventEmitter, NativeModules, PermissionsAndroid } from 'react-native';
import { UNAVAILABLE_SPEECH, type SpeechFailure, type SpeechPort } from '@macros/tablet-voice';

/**
 * NATIVE SPEECH ADAPTER.
 *
 * Binds the MACROS Kotlin bridge to the application's SpeechPort. If the module
 * is absent — an older build, a failed hydrate — this returns the unavailable
 * port rather than throwing, so a missing native module costs voice and nothing
 * else.
 */
export const NATIVE_SPEECH_VERSION = 'native-speech-adapter@1.0.0';

interface NativeSpeech {
  isAvailable(): Promise<boolean>;
  startListening(): void;
  stopListening(): void;
  speak(text: string, speechId: string): void;
  stopSpeaking(): void;
  playBase64Audio(audioBase64: string, mimeType: string, speechId: string): void;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

/**
 * Ask for the microphone at the moment it is first needed.
 *
 * Denial is a normal outcome, not an error: the caller falls back to touch.
 */
async function ensureMicrophonePermission(): Promise<boolean> {
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Microphone',
        message: 'MACROS listens only while you hold the button.',
        buttonPositive: 'Allow',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function createNativeSpeechPort(): SpeechPort {
  const native = (NativeModules as { MacrosSpeech?: NativeSpeech }).MacrosSpeech;
  // An absent module costs voice and nothing else; the caller is told plainly.
  if (native === undefined) return UNAVAILABLE_SPEECH;

  const emitter = new NativeEventEmitter(native as never);
  let permissionChecked = false;
  let permitted = false;

  return {
    async isAvailable() {
      try {
        return await native.isAvailable();
      } catch {
        return false;
      }
    },

    /**
     * Reports whether listening actually began.
     *
     * The previous version fired and forgot: if permission was denied nothing
     * started and no event was emitted, so the orb sat on "Listening…"
     * indefinitely. The caller now learns the outcome and can settle.
     */
    startListening: async () => {
      if (!permissionChecked) {
        permitted = await ensureMicrophonePermission();
        permissionChecked = true;
      }
      if (!permitted) return 'permission_denied';
      try {
        native.startListening();
        return 'started';
      } catch {
        return 'unavailable';
      }
    },

    stopListening: () => { native.stopListening(); },
    speak: (text: string, speechId: string) => { native.speak(text, speechId); },
    stopSpeaking: () => { native.stopSpeaking(); },

    onResult: (handler) => {
      const sub = emitter.addListener('MacrosSpeechResult',
        (e: { transcript?: string }) => {
          const transcript = e.transcript ?? '';
          if (transcript.length > 0) handler(transcript);
        });
      return () => { sub.remove(); };
    },

    onStateChange: (handler) => {
      const started = emitter.addListener('MacrosSpeechStart', () => { handler('listening'); });
      const ended = emitter.addListener('MacrosSpeechEnd', () => { handler('idle'); });
      return () => { started.remove(); ended.remove(); };
    },

    playAudio: (audioBase64: string, mimeType: string, speechId: string) => {
      native.playBase64Audio(audioBase64, mimeType, speechId);
    },

    onPremiumFailure: (handler) => {
      const sub = emitter.addListener('MacrosPremiumSpeechError',
        (e: { speechId?: string }) => { handler(e.speechId ?? null); });
      return () => { sub.remove(); };
    },

    onPlaybackStart: (handler) => {
      const sub = emitter.addListener('MacrosSpeechPlaybackStart',
        (e: { speechId?: string }) => { handler(e.speechId ?? null); });
      return () => { sub.remove(); };
    },

    onLevel: (handler) => {
      const sub = emitter.addListener('MacrosSpeechLevel',
        (e: { rmsDb?: number }) => {
          if (typeof e.rmsDb === 'number') handler(e.rmsDb);
        });
      return () => { sub.remove(); };
    },

    onPartial: (handler) => {
      const sub = emitter.addListener('MacrosSpeechPartial',
        (e: { transcript?: string }) => { handler(e.transcript ?? ''); });
      return () => { sub.remove(); };
    },

    onSpeechFinished: (handler) => {
      const sub = emitter.addListener('MacrosSpeechDone',
        (e: { speechId?: string }) => { handler(e.speechId ?? null); });
      return () => { sub.remove(); };
    },

    onError: (handler) => {
      const sub = emitter.addListener('MacrosSpeechError',
        (e: { reason?: string }) => {
          // Only known reason codes cross into the app; an unfamiliar one is
          // reported as unavailable rather than surfacing raw Android wording.
          const known: readonly SpeechFailure[] =
            ['permission_denied', 'no_speech', 'network', 'unavailable'];
          const reason = known.find((r) => r === e.reason) ?? 'unavailable';
          handler(reason);
        });
      return () => { sub.remove(); };
    },
  };
}
