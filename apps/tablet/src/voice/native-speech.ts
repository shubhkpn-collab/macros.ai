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
  speak(text: string): void;
  stopSpeaking(): void;
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

    startListening: () => {
      void (async () => {
        if (!permissionChecked) {
          permitted = await ensureMicrophonePermission();
          permissionChecked = true;
        }
        // Without permission the native call would emit an error anyway; not
        // making it keeps the failure quiet and the UI on the touch path.
        if (permitted) native.startListening();
      })();
    },

    stopListening: () => { native.stopListening(); },
    speak: (text: string) => { native.speak(text); },
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
