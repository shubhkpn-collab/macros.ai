import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, MAX_SPEECH_CHARACTERS, VOICE_INSTRUCTIONS,
  createOpenAiSpeechProvider,
} from '@macros/voice-openai';
import { decodeSpeechRequest } from '@macros/runtime-api';
import {
  LevelSmoother, SEGMENT_COUNT, SpeechAttempt, containsWakePhrase,
  decodeAudioResponse, interpretVoiceCommand, normalizeRms, segmentAngle,
  segmentHeights, stripWakePhrase,
} from '@macros/tablet-voice';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FAKE_KEY = 'sk-openai-DO-NOT-LEAK-999';

const mp3 = () => new TextEncoder().encode('ID3fake-audio').buffer;

const okFetch = (captured: { body?: string; headers?: Record<string, string> }) =>
  (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    captured.body = init.body;
    captured.headers = init.headers;
    return { status: 200, arrayBuffer: async () => mp3(), text: async () => '' };
  }) as never;

describe('TTS — the OpenAI provider', () => {
  test('a key produces a provider; no key produces none', () => {
    assert.notEqual(createOpenAiSpeechProvider({ apiKey: FAKE_KEY }, okFetch({})), null);
    assert.equal(createOpenAiSpeechProvider(null, okFetch({})), null);
    // An empty key is the same as no key — it must not reach the network.
    assert.equal(createOpenAiSpeechProvider({ apiKey: '' }, okFetch({})), null);
  });

  test('the request carries the defaults and the style instructions', async () => {
    const captured: { body?: string; headers?: Record<string, string> } = {};
    const provider = createOpenAiSpeechProvider({ apiKey: FAKE_KEY }, okFetch(captured))!;
    const result = await provider.synthesize('Chicken breast would help.');

    assert.equal(result.ok, true);
    const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['model'], DEFAULT_TTS_MODEL);
    assert.equal(DEFAULT_TTS_MODEL, 'gpt-4o-mini-tts');
    assert.equal(body['voice'], DEFAULT_TTS_VOICE);
    assert.equal(DEFAULT_TTS_VOICE, 'onyx');
    assert.equal(body['response_format'], 'mp3');
    assert.equal(body['instructions'], VOICE_INSTRUCTIONS);
    assert.match(VOICE_INSTRUCTIONS, /Male-sounding/);
  });

  test('the codebase never names the ChatGPT voice', () => {
    // The product target is male-sounding and composed; the exact voice is not
    // being claimed.
    const src = read('packages', 'voice-openai', 'src', 'index.ts');
    assert.equal(/\bCove\b/i.test(src), false);
  });

  test('a non-200 falls back rather than throwing', async () => {
    const provider = createOpenAiSpeechProvider({ apiKey: FAKE_KEY },
      (async () => ({ status: 500, arrayBuffer: async () => mp3(), text: async () => 'boom' })) as never)!;
    const result = await provider.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'provider_error');
  });

  test('an empty body is refused', async () => {
    const provider = createOpenAiSpeechProvider({ apiKey: FAKE_KEY },
      (async () => ({
        status: 200, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '',
      })) as never)!;
    assert.equal((await provider.synthesize('hello')).ok, false);
  });

  test('the timeout aborts the request', async () => {
    let aborted = false;
    const provider = createOpenAiSpeechProvider(
      { apiKey: FAKE_KEY, timeoutMs: 20 },
      ((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })) as never)!;
    const result = await provider.synthesize('hello');
    assert.equal(result.ok, false);
    // Abandoning a paid call while it runs is a bill for audio nobody hears.
    assert.equal(aborted, true);
  });

  test('text bounds are enforced before any request', async () => {
    let called = false;
    const provider = createOpenAiSpeechProvider({ apiKey: FAKE_KEY },
      (async () => { called = true; return { status: 200, arrayBuffer: async () => mp3(), text: async () => '' }; }) as never)!;
    assert.equal((await provider.synthesize('   ')).ok, false);
    assert.equal((await provider.synthesize('x'.repeat(MAX_SPEECH_CHARACTERS + 1))).ok, false);
    assert.equal(called, false, 'invalid text must not reach the network');
  });

  test('one attempt only — no retry', () => {
    const src = strip(read('packages', 'voice-openai', 'src', 'index.ts'));
    assert.equal((src.match(/fetchImpl\(/g) ?? []).length, 1);
    assert.equal(/retry|backoff/i.test(src), false);
  });

  test('the key never leaves the provider', async () => {
    const captured: { body?: string; headers?: Record<string, string> } = {};
    const provider = createOpenAiSpeechProvider({ apiKey: FAKE_KEY }, okFetch(captured))!;
    const result = await provider.synthesize('hello');
    // Present on the outbound call only, never in the returned payload.
    assert.match(captured.headers?.['authorization'] ?? '', /DO-NOT-LEAK/);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
});

describe('TTS — the /voice/speak route', () => {
  const isError = (v: unknown): boolean =>
    (v as { kind?: string }).kind !== 'decoded_speech_request';

  test('a valid body decodes and is trimmed', () => {
    const decoded = decodeSpeechRequest({ text: '  Chicken breast.  ' });
    assert.equal(isError(decoded), false);
    assert.equal((decoded as { text: string }).text, 'Chicken breast.');
  });

  test('empty, oversized and unknown fields are refused', () => {
    assert.equal(isError(decodeSpeechRequest({ text: '   ' })), true);
    assert.equal(isError(decodeSpeechRequest({ text: 'x'.repeat(601) })), true);
    assert.equal(isError(decodeSpeechRequest({ text: 'hi', voice: 'other' })), true);
    assert.equal(isError(decodeSpeechRequest({ text: 42 as never })), true);
    // It speaks MACROS' own sentences; it is not a general TTS service.
    assert.equal(isError(decodeSpeechRequest({ prompt: 'anything' })), true);
  });

  test('a missing key answers unavailable without a network call', () => {
    const route = strip(read('packages', 'runtime-api', 'src', 'voice-route.ts'));
    assert.match(route, /deps\.provider === null/);
    assert.match(route, /speech_unavailable/);
  });

  test('the route leaks no vendor wording', () => {
    const route = read('packages', 'runtime-api', 'src', 'voice-route.ts');
    assert.equal(/openai\.com|OPENAI_API_KEY|gpt-4o/i.test(strip(route)), false);
  });
});

describe('TTS — exactly once, behaviourally', () => {
  test('an HTTP success does NOT yet block the fallback', () => {
    // The bug this replaces: marking premium as playing when the bytes arrived
    // blocked the native tier behind a sound nobody ever heard.
    const attempt = new SpeechAttempt();
    assert.equal(attempt.claimPremiumRequest(), true);
    assert.equal(attempt.playingPremium, false);
    assert.equal(attempt.claimNativeSpeech(), true,
      'before playback starts, the native tier must still be available');
  });

  test('playback-start makes premium audible and blocks the fallback', () => {
    const attempt = new SpeechAttempt();
    attempt.claimPremiumRequest();
    attempt.markPremiumAudible();
    assert.equal(attempt.playingPremium, true);
    assert.equal(attempt.claimNativeSpeech(), false);
  });

  test('a failure BEFORE playback falls back exactly once', () => {
    const attempt = new SpeechAttempt();
    attempt.claimPremiumRequest();
    attempt.markPremiumFailed();
    assert.equal(attempt.claimNativeSpeech(), true);
    assert.equal(attempt.claimNativeSpeech(), false);
  });

  test('a failure AFTER playback started still falls back once', () => {
    // A track that cut out halfway is a failure; the user should still hear it.
    const attempt = new SpeechAttempt();
    attempt.claimPremiumRequest();
    attempt.markPremiumAudible();
    attempt.markPremiumFailed();
    assert.equal(attempt.claimNativeSpeech(), true);
    assert.equal(attempt.claimNativeSpeech(), false);
  });

  test('a stale event after the fallback speaks nothing', () => {
    const attempt = new SpeechAttempt();
    attempt.claimPremiumRequest();
    attempt.markPremiumFailed();
    assert.equal(attempt.claimNativeSpeech(), true);
    attempt.markPremiumFailed();
    assert.equal(attempt.claimNativeSpeech(), false);
  });

  test('a re-render cannot buy a second premium request', () => {
    const attempt = new SpeechAttempt();
    assert.equal(attempt.claimPremiumRequest(), true);
    assert.equal(attempt.claimPremiumRequest(), false);
    assert.equal(attempt.claimPremiumRequest(), false);
  });

  test('audible premium is not resurrected by a late start event', () => {
    const attempt = new SpeechAttempt();
    attempt.claimPremiumRequest();
    attempt.markPremiumFailed();
    attempt.claimNativeSpeech();
    // A playback-start arriving after the failure must not block anything now.
    attempt.markPremiumAudible();
    assert.equal(attempt.playingPremium, false);
  });
});

describe('TTS — wire response validation', () => {
  test('valid audio decodes', () => {
    const r = decodeAudioResponse({ mimeType: 'audio/mpeg', audioBase64: 'QUJD' });
    assert.equal(r.ok, true);
  });

  test('every malformed shape falls back with a reason', () => {
    assert.equal(decodeAudioResponse(null).ok, false);
    assert.equal(decodeAudioResponse('nope').ok, false);
    const wrongMime = decodeAudioResponse({ mimeType: 'audio/wav', audioBase64: 'QUJD' });
    assert.equal(wrongMime.ok === false && wrongMime.reason, 'wrong_mime');
    const empty = decodeAudioResponse({ mimeType: 'audio/mpeg', audioBase64: '' });
    assert.equal(empty.ok === false && empty.reason, 'empty_audio');
    const missing = decodeAudioResponse({ mimeType: 'audio/mpeg' });
    assert.equal(missing.ok === false && missing.reason, 'malformed');
  });
});

describe('VOICE — the wake phrase', () => {
  test('the same intent results with or without it', () => {
    const withWake = interpretVoiceCommand('Hey Macros, what should I eat?', 0);
    const without = interpretVoiceCommand('what should I eat?', 0);
    assert.deepEqual(withWake, without);
    assert.equal(withWake.kind, 'request_guidance');
  });

  test('common variants are stripped', () => {
    for (const phrase of ['hey macros what should i eat', 'macros what should i eat',
                          'ok macros, what should i eat', 'Hey, Macros what should I eat']) {
      assert.equal(interpretVoiceCommand(phrase, 0).kind, 'request_guidance', phrase);
    }
  });

  test('other command semantics are unchanged', () => {
    assert.equal(interpretVoiceCommand('hey macros log it', 1).kind, 'log');
    assert.equal(interpretVoiceCommand('log it', 1).kind, 'log');
    assert.deepEqual(interpretVoiceCommand('option one', 2), { kind: 'choose_option', index: 0 });
  });

  test('the phrase is detectable for the orb acknowledgement', () => {
    assert.equal(containsWakePhrase('Hey Macros, what should I eat'), true);
    assert.equal(containsWakePhrase('what should I eat'), false);
    assert.equal(stripWakePhrase('hey macros what should i eat'), 'what should i eat');
  });
});

describe('VOICE — the live waveform', () => {
  test('noisy RMS is clamped into 0–1', () => {
    assert.equal(normalizeRms(-100), 0);
    assert.equal(normalizeRms(1000), 1);
    assert.equal(normalizeRms(Number.NaN), 0);
    const mid = normalizeRms(4);
    assert.ok(mid > 0 && mid < 1);
  });

  test('loud speech reads higher than quiet speech', () => {
    assert.ok(normalizeRms(9) > normalizeRms(0));
  });

  test('levels rise quickly and fall slowly', () => {
    // Symmetric smoothing reads as a pulsing lamp rather than a voice.
    const s = new LevelSmoother();
    const rise = s.push(1);
    const fall = new LevelSmoother();
    fall.push(1); fall.push(1); fall.push(1);
    const before = fall.current;
    fall.push(0);
    assert.ok(rise > 0.3, 'attack is responsive');
    assert.ok(before - fall.current < before * 0.5, 'release is gentle');
  });

  test('silence settles to rest', () => {
    const s = new LevelSmoother();
    s.push(1);
    for (let i = 0; i < 200; i += 1) s.push(0);
    assert.equal(s.current, 0);
  });

  test('strokes keep a stable shape and only change amplitude', () => {
    const quiet = segmentHeights(0.1);
    const loud = segmentHeights(0.9);
    assert.equal(quiet.length, SEGMENT_COUNT);
    assert.equal(loud.length, SEGMENT_COUNT);
    // The FORM is fixed; only amplitude moves. Random per-stroke heights would
    // read as a music visualiser rather than one voice.
    for (let i = 0; i < SEGMENT_COUNT; i += 1) {
      assert.ok(loud[i]! >= quiet[i]!, `stroke ${i} did not grow`);
    }
    // Deterministic: the same level always draws the same ring.
    assert.deepEqual(segmentHeights(0.5), segmentHeights(0.5));
  });

  test('strokes are arranged AROUND the circle, not in a row', () => {
    // The previous build rendered seven bars in a flexDirection row and called
    // them radial. These are real rotations.
    assert.equal(segmentAngle(0), 0);
    assert.equal(segmentAngle(SEGMENT_COUNT / 2), 180);
    assert.ok(SEGMENT_COUNT >= 16 && SEGMENT_COUNT <= 24);

    const orb = read('apps', 'tablet', 'src', 'components', 'MacrosOrb.tsx');
    assert.match(orb, /rotate: `\$\{String\(segmentAngle\(index\)\)\}deg`/);
    assert.equal(orb.includes("flexDirection: 'row', alignItems: 'center',\n              height: 120"), false);
  });

  test('no audio is recorded, stored or transmitted', () => {
    const kotlin = strip(read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
      'com', 'macrostablet', 'MacrosSpeechModule.kt'));
    for (const banned of ['MediaRecorder', 'AudioRecord', 'writeAudio', 'uploadAudio']) {
      assert.equal(kotlin.includes(banned), false, `kotlin references ${banned}`);
    }
    // Amplitude only, and it is throttled before crossing the bridge.
    assert.match(kotlin, /putDouble\("rmsDb"/);
    assert.match(kotlin, /now - lastLevelAt < 60/);

    // No history buffer: an unbounded array on an always-on appliance leaks.
    // The smoother keeps ONE number, so there is nothing to grow.
    const waveform = strip(read('packages', 'tablet-voice', 'src', 'waveform.ts'));
    for (const banned of ['.push(', 'history', 'samples', 'buffer']) {
      assert.equal(waveform.includes(banned), false, `waveform retains ${banned}`);
    }
    assert.match(waveform, /private value = 0/);
  });

  test('microphone levels only move the orb while listening', () => {
    const code = read('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts');
    // Speaking uses a controlled animation; the microphone is not the source.
    assert.match(code, /if \(!this\.listening\) return 0;/);
  });
});

describe('TTS — the native player lifecycle', () => {
  const kotlin = () => read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
    'com', 'macrostablet', 'MacrosSpeechModule.kt');

  test('playBase64Audio exists and validates the MIME type', () => {
    const code = kotlin();
    assert.match(code, /fun playBase64Audio\(audioBase64: String, mimeType: String, speechId: String\)/);
    assert.match(code, /mimeType != "audio\/mpeg"/);
    assert.match(code, /Base64\.decode/);
  });

  test('the player and its temp file are always released', () => {
    const code = kotlin();
    assert.match(code, /private fun releasePlayer\(\)/);
    assert.match(code, /player\?\.release\(\)/);
    assert.match(code, /tempAudio\?\.delete\(\)/);
    // Completion, error, stop, new playback and teardown all clean up.
    assert.ok((code.match(/releasePlayer\(\)/g) ?? []).length >= 5);
    assert.match(code, /cacheDir/);
  });

  test('exactly one ending is emitted per utterance', () => {
    const code = kotlin();
    assert.match(code, /private fun emitFinishOnce\(speechId: String\?\)/);
    assert.match(code, /if \(finishEmitted\) return/);
    // The raw event is emitted from that one guarded place only.
    assert.equal((code.match(/emit\("MacrosSpeechDone"/g) ?? []).length, 1);
  });

  test('playback start is a distinct event, so the orb lights only when audible', () => {
    assert.match(kotlin(), /MacrosSpeechPlaybackStart/);
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    void app;
  });

  test('the native method names match the JS adapter exactly', () => {
    const code = kotlin();
    const adapter = read('apps', 'tablet', 'src', 'voice', 'native-speech.ts');
    for (const name of ['playBase64Audio', 'startListening', 'stopListening',
                        'speak', 'stopSpeaking', 'isAvailable']) {
      assert.ok(code.includes(`fun ${name}`), `kotlin missing ${name}`);
      assert.ok(adapter.includes(name), `adapter missing ${name}`);
    }
    for (const event of ['MacrosSpeechLevel', 'MacrosSpeechPartial',
                         'MacrosSpeechPlaybackStart', 'MacrosPremiumSpeechError']) {
      assert.ok(code.includes(event), `kotlin missing event ${event}`);
      assert.ok(adapter.includes(event), `adapter missing event ${event}`);
    }
  });

  test('no third-party audio library was added', async () => {
    const pkg = JSON.parse(read('apps', 'tablet', 'package.json')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const d of deps) {
      assert.equal(/sound|audio|player|tts/i.test(d), false, `unexpected audio dep ${d}`);
    }
  });
});

describe('VOICE — the wake acknowledgement', () => {
  /** Minimal coordinator harness; no device, no React. */
  const makeCoordinator = async () => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const spoken: string[] = [];
    const played: string[] = [];
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started',
      stopListening: () => undefined,
      speak: (t: string) => { spoken.push(t); },
      stopSpeaking: () => undefined,
      playAudio: (b: string) => { played.push(b); },
      onResult: () => () => undefined,
      onStateChange: () => () => undefined,
      onError: () => () => undefined,
      onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined,
      onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined,
      onPartial: () => () => undefined,
    };
    const actions = {
      onRequestGuidance: () => undefined, onChooseGuidanceCandidate: () => undefined,
      onLog: () => undefined, onCancel: () => undefined,
    };
    const vm = { guidance: { candidates: [], envelopeId: null, text: '', phase: 'idle' } };
    const coordinator = new VoiceCoordinator({
      speech: speech as never, actions: actions as never, viewModel: () => vm as never,
    });
    return { coordinator, spoken, played };
  };

  test('the wake phrase acknowledges exactly once per session', async () => {
    const { coordinator } = await makeCoordinator();
    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true);
    // Repeated partials keep arriving as the sentence continues.
    assert.equal(coordinator.handlePartial('hey macros what'), false);
    assert.equal(coordinator.handlePartial('hey macros what should i eat'), false);
  });

  test('a partial without the phrase acknowledges nothing', async () => {
    const { coordinator } = await makeCoordinator();
    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('what should i eat'), false);
  });

  test('a new session may acknowledge again', async () => {
    const { coordinator } = await makeCoordinator();
    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true);
    coordinator.handleTranscript('hey macros what should i eat');
    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true);
  });

  test('recognition failure ends the session cleanly', async () => {
    const { coordinator } = await makeCoordinator();
    await coordinator.toggleListening();
    coordinator.handleRecognitionEnded();
    // Not listening any more, so nothing acknowledges and the orb settles.
    assert.equal(coordinator.handlePartial('hey macros'), false);
    assert.equal(coordinator.currentLevel(), 0);
  });

  test('microphone levels only move while listening', async () => {
    const { coordinator } = await makeCoordinator();
    assert.equal(coordinator.handleLevel(8), 0, 'idle must not move the orb');
    await coordinator.toggleListening();
    assert.ok(coordinator.handleLevel(8) > 0);
    // Speaking uses its own animation; the microphone is not the source.
    coordinator.handleRecognitionEnded();
    assert.equal(coordinator.handleLevel(8), 0);
  });

  test('louder speech produces a larger response', async () => {
    const { coordinator } = await makeCoordinator();
    await coordinator.toggleListening();
    for (let i = 0; i < 5; i += 1) coordinator.handleLevel(1);
    const quiet = coordinator.currentLevel();
    for (let i = 0; i < 5; i += 1) coordinator.handleLevel(9);
    assert.ok(coordinator.currentLevel() > quiet);
  });
});

describe('VOICE — the premium chain end to end', () => {
  const harness = async (premiumOutcome: unknown) => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const spoken: string[] = [];
    const played: string[] = [];
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started', stopListening: () => undefined,
      speak: (t: string) => { spoken.push(t); },
      stopSpeaking: () => undefined,
      playAudio: (b: string) => { played.push(b); },
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = {
      guidance: {
        candidates: [], envelopeId: 'env-1', phase: 'awaiting_choice',
        text: 'Chicken breast would help.',
      },
    };
    const coordinator = new VoiceCoordinator({
      speech: speech as never,
      actions: {} as never,
      viewModel: () => vm as never,
      premium: { requestAudio: async () => premiumOutcome as never },
    });
    return { coordinator, spoken, played };
  };

  const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });

  test('premium success plays audio and native stays silent', async () => {
    const { coordinator, spoken, played } = await harness(
      { ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    coordinator.speakGuidanceIfNew();
    await settle();
    assert.deepEqual(played, ['QUJD']);
    assert.deepEqual(spoken, [], 'native must not speak alongside premium');
  });

  test('a server failure falls back to native exactly once', async () => {
    const { coordinator, spoken, played } = await harness(
      { ok: false, reason: 'http_error' });
    coordinator.speakGuidanceIfNew();
    await settle();
    assert.deepEqual(played, []);
    assert.equal(spoken.length, 1);
  });

  test('a playback failure after audio arrived still falls back once', async () => {
    // The defect this closes: premium was marked playing on HTTP success, so
    // MediaPlayer failure could never reach the native tier.
    const { coordinator, spoken, played } = await harness(
      { ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    coordinator.speakGuidanceIfNew();
    await settle();
    assert.deepEqual(played, ['QUJD']);

    coordinator.handlePremiumFailure(null);
    assert.equal(spoken.length, 1, 'native must speak the same sentence once');
    coordinator.handlePremiumFailure(null);
    assert.equal(spoken.length, 1, 'a repeated failure must not speak twice');
  });

  test('a failure once premium is audible still falls back', async () => {
    const { coordinator, spoken } = await harness(
      { ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    coordinator.speakGuidanceIfNew();
    await settle();
    coordinator.handlePlaybackStart(null);
    assert.equal(coordinator.isSpeaking(), true);
    coordinator.handlePremiumFailure(null);
    assert.equal(spoken.length, 1);
  });

  test('completion returns the orb to idle', async () => {
    const { coordinator } = await harness({ ok: false, reason: 'timeout' });
    coordinator.speakGuidanceIfNew();
    await settle();
    coordinator.markSpeechFinished();
    assert.equal(coordinator.isSpeaking(), false);
    // Pending text is cleared, so a late failure cannot re-speak it.
    coordinator.handlePremiumFailure(null);
    assert.equal(coordinator.isSpeaking(), false);
  });

  test('an interruption speaks nothing further', async () => {
    const { coordinator, spoken } = await harness(
      { ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    coordinator.speakGuidanceIfNew();
    await settle();
    coordinator.handlePlaybackStart(null);
    // The user taps to talk over it.
    await coordinator.toggleListening();
    assert.equal(coordinator.isListening(), true);
    assert.equal(coordinator.isSpeaking(), false);
    assert.deepEqual(spoken, []);
  });

  test('one utterance is spoken once despite re-renders', async () => {
    const { coordinator, played } = await harness(
      { ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    coordinator.speakGuidanceIfNew();
    coordinator.speakGuidanceIfNew();
    coordinator.speakGuidanceIfNew();
    await settle();
    assert.deepEqual(played, ['QUJD'], 'React re-renders must not replay audio');
  });
});

describe('VOICE — a second recommendation still speaks', () => {
  /** A view model whose envelope can change, as it does between questions. */
  const harness = async () => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const spoken: string[] = [];
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started', stopListening: () => undefined,
      speak: (t: string) => { spoken.push(t); },
      stopSpeaking: () => undefined, playAudio: () => undefined,
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = {
      guidance: {
        candidates: [], envelopeId: 'env-1', phase: 'awaiting_choice',
        text: 'Chicken breast would help.',
      },
    };
    const coordinator = new VoiceCoordinator({
      speech: speech as never, actions: {} as never, viewModel: () => vm as never,
    });
    return { coordinator, spoken, vm };
  };

  test('a NEW envelope speaks again even with identical text and phase', async () => {
    const { coordinator, spoken, vm } = await harness();

    coordinator.speakGuidanceIfNew();
    assert.equal(spoken.length, 1);

    // Ask again after logging: same sentence, same phase, new envelope. This is
    // exactly the second half of the investor flow.
    vm.guidance.envelopeId = 'env-2';
    coordinator.speakGuidanceIfNew();
    assert.equal(spoken.length, 2, 'the second recommendation must be spoken');
  });

  test('the SAME envelope never speaks twice', async () => {
    const { coordinator, spoken } = await harness();
    coordinator.speakGuidanceIfNew();
    coordinator.speakGuidanceIfNew();
    coordinator.speakGuidanceIfNew();
    assert.equal(spoken.length, 1, 'a re-render must not repeat an answer');
  });

  test('the React effect watches the envelope the coordinator keys on', () => {
    // The coordinator was willing to speak; the effect simply never asked it.
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    const effect = app.slice(app.indexOf('voice.speakGuidanceIfNew()'));
    const deps = effect.slice(effect.indexOf('}, ['), effect.indexOf(']', effect.indexOf('}, [')));
    assert.match(deps, /vm\.guidance\.envelopeId/);
    assert.match(deps, /vm\.guidance\.text/);
    assert.match(deps, /vm\.guidance\.phase/);

    const coordinator = read('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts');
    assert.match(coordinator, /const key = `\$\{vm\.guidance\.envelopeId \?\? 'none'\}/);
  });
});

describe('VOICE — SPEAKING means audible, nothing sooner', () => {
  /** A premium transport whose response can be released on demand. */
  const harness = async () => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const spoken: string[] = [];
    const played: string[] = [];
    let release: ((v: unknown) => void) | null = null;
    const pending = new Promise((r) => { release = r; });

    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started', stopListening: () => undefined,
      speak: (t: string) => { spoken.push(t); },
      stopSpeaking: () => undefined,
      playAudio: (b: string) => { played.push(b); },
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = {
      guidance: {
        candidates: [], envelopeId: 'env-1', phase: 'awaiting_choice',
        text: 'Chicken breast would help.',
      },
    };
    const coordinator = new VoiceCoordinator({
      speech: speech as never, actions: {} as never, viewModel: () => vm as never,
      premium: { requestAudio: async () => await pending as never },
    });
    return {
      coordinator, spoken, played, vm,
      resolve: (outcome: unknown) => { release?.(outcome); },
    };
  };

  const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });

  test('a pending premium request does NOT light the orb', async () => {
    const { coordinator } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    // Server round trip, generation and download are all silent.
    assert.equal(coordinator.isSpeaking(), false);
  });

  test('bytes returned but no playback-start still does not light the orb', async () => {
    const { coordinator, played, resolve } = await harness();
    coordinator.speakGuidanceIfNew();
    resolve({ ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    await settle();
    assert.deepEqual(played, ['QUJD']);
    // MediaPlayer is still preparing; preparing is not hearing.
    assert.equal(coordinator.isSpeaking(), false);
  });

  test('playback-start is the premium transition to SPEAKING', async () => {
    const { coordinator, resolve } = await harness();
    coordinator.speakGuidanceIfNew();
    resolve({ ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } });
    await settle();
    coordinator.handlePlaybackStart(null);
    assert.equal(coordinator.isSpeaking(), true);
    coordinator.markSpeechFinished();
    assert.equal(coordinator.isSpeaking(), false);
  });

  test('a premium failure before playback falls back once and IS audible', async () => {
    const { coordinator, spoken, resolve } = await harness();
    coordinator.speakGuidanceIfNew();
    resolve({ ok: false, reason: 'http_error' });
    await settle();
    assert.equal(spoken.length, 1);
    // Native TTS is audible the moment it is asked to speak.
    assert.equal(coordinator.isSpeaking(), true);
    coordinator.markSpeechFinished();
    assert.equal(coordinator.isSpeaking(), false);
  });
});

describe('VOICE — native playback-start contract', () => {
  const kotlin = () => read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
    'com', 'macrostablet', 'MacrosSpeechModule.kt');

  test('start() runs BEFORE the event is announced', () => {
    const code = kotlin();
    const prepared = code.slice(code.indexOf('setOnPreparedListener'),
      code.indexOf('setOnCompletionListener'));
    assert.ok(prepared.indexOf('it.start()') < prepared.indexOf('MacrosSpeechPlaybackStart'),
      'the event must mean playback started, not that preparation finished');
  });

  test('a start failure emits NO playback-start and does fall back', () => {
    const code = kotlin();
    const prepared = code.slice(code.indexOf('setOnPreparedListener'),
      code.indexOf('setOnCompletionListener'));
    assert.match(prepared, /catch \(t: Throwable\) \{/);
    assert.match(prepared, /emitPremiumFailureOnce\(speechId\)/);
    // The announcement sits inside the try, after start().
    assert.ok(prepared.indexOf('MacrosSpeechPlaybackStart')
      < prepared.indexOf('catch (t: Throwable)'));
  });
});

describe('VOICE — a manual stop still allows a new acknowledgement', () => {
  const makeCoordinator = async () => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started', stopListening: () => undefined,
      speak: () => undefined, stopSpeaking: () => undefined, playAudio: () => undefined,
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = { guidance: { candidates: [], envelopeId: null, text: '', phase: 'idle' } };
    return new VoiceCoordinator({
      speech: speech as never, actions: {} as never, viewModel: () => vm as never,
    });
  };

  test('stopping manually and listening again acknowledges again', async () => {
    const coordinator = await makeCoordinator();

    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true);

    // Manual stop: no final result, no error — neither reset path runs.
    await coordinator.toggleListening();
    assert.equal(coordinator.isListening(), false);

    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true,
      'a new session must be able to acknowledge again');
  });

  test('repeated partials within one session acknowledge once', async () => {
    const coordinator = await makeCoordinator();
    await coordinator.toggleListening();
    assert.equal(coordinator.handlePartial('hey macros'), true);
    assert.equal(coordinator.handlePartial('hey macros what'), false);
    assert.equal(coordinator.handlePartial('hey macros what should i eat'), false);
  });
});

describe('CLOSURE — listening start reports its outcome', () => {
  const build = async (start: () => Promise<unknown>) => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const speech = {
      isAvailable: async () => true,
      startListening: start,
      stopListening: () => undefined,
      speak: () => undefined, stopSpeaking: () => undefined, playAudio: () => undefined,
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = { guidance: { candidates: [], envelopeId: null, text: '', phase: 'idle' } };
    return new VoiceCoordinator({
      speech: speech as never, actions: {} as never, viewModel: () => vm as never,
    });
  };

  test('a granted microphone begins listening', async () => {
    const c = await build(async () => 'started');
    assert.equal(await c.toggleListening(), 'started');
    assert.equal(c.isListening(), true);
  });

  test('denied permission does NOT leave the orb listening', async () => {
    // The stuck-orb bug: no native event could ever arrive to correct an
    // optimistic flag.
    const c = await build(async () => 'permission_denied');
    assert.equal(await c.toggleListening(), 'refused');
    assert.equal(c.isListening(), false);
    assert.equal(c.currentLevel(), 0, 'the waveform must settle');
  });

  test('an unavailable service does not leave the orb listening', async () => {
    const c = await build(async () => 'unavailable');
    assert.equal(await c.toggleListening(), 'refused');
    assert.equal(c.isListening(), false);
  });

  test('an absent native module reports unavailable, never hangs', async () => {
    const { UNAVAILABLE_SPEECH } = await import('@macros/tablet-voice');
    assert.equal(await UNAVAILABLE_SPEECH.startListening(), 'unavailable');
    const c = await build(() => UNAVAILABLE_SPEECH.startListening());
    assert.equal(await c.toggleListening(), 'refused');
    assert.equal(c.isListening(), false);
  });

  test('a refused start still allows a later successful one', async () => {
    let outcome = 'permission_denied';
    const c = await build(async () => outcome);
    await c.toggleListening();
    outcome = 'started';
    assert.equal(await c.toggleListening(), 'started');
  });
});

describe('CLOSURE — stale native events cannot touch a new utterance', () => {
  const harness = async () => {
    const { VoiceCoordinator } = await import('../apps/tablet/src/voice/voice-coordinator.js');
    const spoken: string[] = [];
    const played: { id: string }[] = [];
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started',
      stopListening: () => undefined,
      speak: (t: string) => { spoken.push(t); },
      stopSpeaking: () => undefined,
      playAudio: (_b: string, _m: string, id: string) => { played.push({ id }); },
      onResult: () => () => undefined, onStateChange: () => () => undefined,
      onError: () => () => undefined, onSpeechFinished: () => () => undefined,
      onPremiumFailure: () => () => undefined, onPlaybackStart: () => () => undefined,
      onLevel: () => () => undefined, onPartial: () => () => undefined,
    };
    const vm = {
      guidance: {
        candidates: [], envelopeId: 'env-1', phase: 'awaiting_choice',
        text: 'First answer.',
      },
    };
    const coordinator = new VoiceCoordinator({
      speech: speech as never, actions: {} as never, viewModel: () => vm as never,
      premium: {
        requestAudio: async () => ({
          ok: true, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' },
        }) as never,
      },
    });
    return { coordinator, spoken, played, vm };
  };
  const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });

  test('a delayed Done(A) does not stop utterance B', async () => {
    const { coordinator, played, vm } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    const idA = played[0]!.id;

    vm.guidance.envelopeId = 'env-2';
    vm.guidance.text = 'Second answer.';
    coordinator.speakGuidanceIfNew();
    await settle();
    const idB = played[1]!.id;
    assert.notEqual(idA, idB);

    coordinator.handlePlaybackStart(idB);
    assert.equal(coordinator.isSpeaking(), true);
    // A's completion arrives late.
    coordinator.markSpeechFinished(idA);
    assert.equal(coordinator.isSpeaking(), true, 'B must keep speaking');
  });

  test('a delayed PremiumFailure(A) does not speak B\'s old text', async () => {
    const { coordinator, spoken, played, vm } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    const idA = played[0]!.id;

    vm.guidance.envelopeId = 'env-2';
    vm.guidance.text = 'Second answer.';
    coordinator.speakGuidanceIfNew();
    await settle();

    coordinator.handlePremiumFailure(idA);
    assert.deepEqual(spoken, [], 'a stale failure must speak nothing');
  });

  test('a delayed PlaybackStart(A) does not light the orb for B', async () => {
    const { coordinator, played, vm } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    const idA = played[0]!.id;

    vm.guidance.envelopeId = 'env-2';
    vm.guidance.text = 'Second answer.';
    coordinator.speakGuidanceIfNew();
    await settle();

    coordinator.handlePlaybackStart(idA);
    assert.equal(coordinator.isSpeaking(), false, 'B is not audible yet');
  });

  test('the CURRENT failure still falls back exactly once', async () => {
    const { coordinator, spoken, played } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    coordinator.handlePremiumFailure(played[0]!.id);
    assert.equal(spoken.length, 1);
    coordinator.handlePremiumFailure(played[0]!.id);
    assert.equal(spoken.length, 1);
  });

  test('the CURRENT completion returns the orb to idle', async () => {
    const { coordinator, played } = await harness();
    coordinator.speakGuidanceIfNew();
    await settle();
    coordinator.handlePlaybackStart(played[0]!.id);
    assert.equal(coordinator.isSpeaking(), true);
    coordinator.markSpeechFinished(played[0]!.id);
    assert.equal(coordinator.isSpeaking(), false);
  });
});

describe('CLOSURE — native lifecycle contracts', () => {
  const kotlin = () => read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
    'com', 'macrostablet', 'MacrosSpeechModule.kt');

  test('the premium guard is armed BEFORE anything that can fail', () => {
    const code = kotlin();
    const body = code.slice(code.indexOf('fun playBase64Audio'),
      code.indexOf('private fun releasePlayer'));
    const armed = body.indexOf('premiumFailureEmitted = false');
    // Corrupted Base64 previously threw while the guard was still set from the
    // previous utterance, swallowing the event and hanging the utterance.
    assert.ok(armed > 0);
    assert.ok(armed < body.indexOf('mimeType != "audio/mpeg"'));
    assert.ok(armed < body.indexOf('Base64.decode'));
    assert.ok(armed < body.indexOf('MediaPlayer()'));
  });

  test('a decode failure reaches the failure path', () => {
    const body = kotlin();
    assert.match(body, /Base64 corruption, file IO or MediaPlayer construction/);
    assert.match(body, /catch \(t: Throwable\) \{[\s\S]{0,200}emitPremiumFailureOnce\(speechId\)/);
  });

  test('every output event carries a speechId', () => {
    const code = kotlin();
    for (const emitter of ['emitPremiumFailureOnce', 'emitFinishOnce']) {
        assert.ok(code.includes(`fun ${emitter}(speechId: String?)`),
        `${emitter} must take a speechId`);
    }
    assert.match(code, /putString\("speechId", speechId\)/);
    // No unqualified call can slip an anonymous ending through.
    assert.equal(/emitFinishOnce\(\)/.test(code), false);
    assert.equal(/emitPremiumFailureOnce\(\)/.test(code), false);
  });

  test('the Android utterance id IS the speech id', () => {
    const code = kotlin();
    assert.match(code, /QUEUE_FLUSH, null, speechId/);
    assert.equal(code.includes('"macros")'), false, 'a constant id cannot identify an utterance');
    assert.match(code, /emitFinishOnce\(utteranceId\)/);
  });

  test('the TTS warm-up keeps the LATEST utterance, not the first', () => {
    const code = kotlin();
    // Fields, not a closure over the first sentence.
    assert.match(code, /pendingTtsText = text/);
    assert.match(code, /pendingTtsId = speechId/);
    assert.match(code, /if \(ttsReady && tts != null\)/);
    // A failed initialization still ends the waiting utterance.
    assert.match(code, /if \(!ttsReady\) \{[\s\S]{0,200}emitFinishOnce\(queuedId\)/);
  });

  test('the JS adapter matches the native signatures', () => {
    const code = kotlin();
    const adapter = read('apps', 'tablet', 'src', 'voice', 'native-speech.ts');
    assert.match(code, /fun speak\(text: String, speechId: String\)/);
    assert.match(code, /fun playBase64Audio\(audioBase64: String, mimeType: String, speechId: String\)/);
    assert.match(adapter, /native\.speak\(text, speechId\)/);
    assert.match(adapter, /native\.playBase64Audio\(audioBase64, mimeType, speechId\)/);
    assert.match(adapter, /handler\(e\.speechId \?\? null\)/);
  });
});

describe('CLOSURE — the investor launcher', () => {
  const script = () => read('tools', 'investor-demo', 'run.sh');

  test('it is strict and finds its own root', () => {
    assert.match(script(), /set -euo pipefail/);
    assert.match(script(), /REPO_ROOT="\$\(cd "\$\(dirname/);
  });

  test('it never contains, echoes or stores a credential', () => {
    const code = script();
    assert.equal(/sk-ant|sk-proj|sk-[a-zA-Z0-9]{20}/.test(code), false);
    // Hidden input, and never written anywhere.
    assert.match(code, /read -r -s -p "Anthropic API key/);
    assert.match(code, /read -r -s -p "OpenAI API key/);
    assert.equal(/echo .*API_KEY|> *\S*key/.test(code), false);
  });

  test('the demo defaults are set but overridable', () => {
    const code = script();
    assert.match(code, /MACROS_GUIDANCE_MODEL:-claude-sonnet-5/);
    assert.match(code, /MACROS_TTS_MODEL:-gpt-4o-mini-tts/);
    assert.match(code, /MACROS_TTS_VOICE:-onyx/);
  });

  test('it refuses to launch unless both providers are live', () => {
    const code = script();
    assert.match(code, /inference {9}: LIVE/);
    assert.match(code, /premium voice {5}: LIVE/);
    assert.match(code, /die "guidance is not live/);
  });

  test('it boots the emulator cleanly and never wipes data', () => {
    const code = script();
    assert.match(code, /-no-snapshot-load/);
    assert.equal(code.includes('-wipe-data'), false);
    assert.match(code, /sys\.boot_completed/);
  });

  test('it detects the installed Postgres service rather than guessing', () => {
    const code = script();
    assert.match(code, /brew services list/);
    assert.equal(/postgresql@1[0-9]/.test(code), false, 'no version may be assumed');
  });

  test('it avoids needless work and grants the microphone ahead of time', () => {
    const code = script();
    assert.match(code, /already hydrated — not re-downloading React Native/);
    assert.match(code, /pm grant "\$APP_ID" android\.permission\.RECORD_AUDIO/);
  });

  test('it cleans up its own processes and watches for silent deaths', () => {
    const code = script();
    assert.match(code, /trap cleanup EXIT INT TERM/);
    assert.match(code, /the backend stopped/);
    assert.match(code, /Metro stopped/);
    assert.match(code, /The emulator is still running/);
  });

  test('the command is registered', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['investor:demo'] ?? '', /investor-demo\/run\.sh/);
  });
});
