import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
/**
 * Imported dynamically: apps/tablet is not an ESM package, so a static import
 * resolves to a default-only namespace here.
 */
const loadCoordinator = async (): Promise<typeof import(
  '../apps/tablet/src/voice/voice-coordinator.js')['VoiceCoordinator']> => {
  const mod = await import('../apps/tablet/src/voice/voice-coordinator.js') as unknown as {
    VoiceCoordinator?: unknown; default?: { VoiceCoordinator: unknown };
  };
  const ctor = mod.VoiceCoordinator ?? mod.default?.VoiceCoordinator;
  return ctor as never;
};

type VoiceCoordinator = InstanceType<Awaited<ReturnType<typeof loadCoordinator>>>;

/**
 * THE INVESTOR FLOW, simulated end to end below Android.
 *
 * This is the test that should have caught the envelopeId dependency bug: it
 * drives the SAME sequence the demo does, including asking the second question
 * whose answer is deliberately identical to the first. A source scan cannot see
 * that failure; only running the flow twice can.
 *
 * The React speech effect is modelled explicitly, with its real dependency
 * list, because the bug lived in the dependency list rather than in the
 * coordinator.
 */

interface Guidance {
  envelopeId: string | null;
  text: string;
  phase: string;
  candidates: { productVersionId: string; displayName: string }[];
}

/** Stands in for the tablet: view model, React effect, native events. */
class DemoHarness {
  readonly guidance: Guidance = {
    envelopeId: null, text: '', phase: 'idle', candidates: [],
  };

  readonly spoken: string[] = [];
  readonly played: { id: string; base64: string }[] = [];
  readonly providerCalls: string[] = [];
  readonly intents: string[] = [];

  premiumOutcome: 'ok' | 'fail' = 'ok';
  /** Held open so a race can be arranged deliberately. */
  private release: (() => void) | null = null;
  private deferred = false;

  coordinator!: VoiceCoordinator;

  /** Mirrors the React effect's dependency list. */
  private lastDeps = '';

  private constructor(private readonly withPremium: boolean) {}

  static async create(withPremium = true): Promise<DemoHarness> {
    const h = new DemoHarness(withPremium);
    await h.build();
    return h;
  }

  private async build(): Promise<void> {
    const withPremium = this.withPremium;
    const Coordinator = await loadCoordinator();
    const speech = {
      isAvailable: async () => true,
      startListening: async () => 'started' as const,
      stopListening: () => undefined,
      speak: (text: string) => { this.spoken.push(text); },
      stopSpeaking: () => undefined,
      playAudio: (base64: string, _mime: string, id: string) => {
        this.played.push({ id, base64 });
      },
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
      onRequestGuidance: () => { this.intents.push('request_guidance'); },
      onChooseGuidanceCandidate: (id: string) => { this.intents.push(`choose:${id}`); },
      onLog: () => { this.intents.push('log'); },
      onCancel: () => { this.intents.push('cancel'); },
    };

    const premium = {
      requestAudio: async (text: string) => {
        this.providerCalls.push(text);
        if (this.deferred) {
          await new Promise<void>((r) => { this.release = r; });
        }
        return this.premiumOutcome === 'ok'
          ? { ok: true as const, audio: { mimeType: 'audio/mpeg', audioBase64: 'QUJD' } }
          : { ok: false as const, reason: 'http_error' as const };
      },
    };

    this.coordinator = new Coordinator({
      speech: speech as never,
      actions: actions as never,
      viewModel: () => ({ guidance: this.guidance }) as never,
      ...(withPremium ? { premium: premium as never } : {}),
    });
  }

  deferPremium(): void { this.deferred = true; }

  releasePremium(): void {
    this.deferred = false;
    this.release?.();
    this.release = null;
  }

  /**
   * One React render.
   *
   * The effect fires only when its declared dependencies change — exactly as
   * React behaves, and exactly where the silent-second-answer bug lived.
   */
  render(): void {
    const deps = [
      this.guidance.envelopeId, this.guidance.text, this.guidance.phase,
    ].join('|');
    if (deps === this.lastDeps) return;
    this.lastDeps = deps;
    this.coordinator.speakGuidanceIfNew();
  }

  /** The engine answers: a new envelope carrying rendered guidance. */
  guidanceArrives(envelopeId: string, text: string, candidates: string[]): void {
    this.guidance.envelopeId = envelopeId;
    this.guidance.text = text;
    this.guidance.phase = 'awaiting_choice';
    this.guidance.candidates = candidates.map((c) => ({
      productVersionId: c, displayName: c,
    }));
    this.render();
  }

  settle(): Promise<void> { return new Promise((r) => { setTimeout(r, 5); }); }
}

describe('INVESTOR FLOW — the full demo, twice', () => {
  test('the complete sequence, with an identical second answer', async () => {
    const h = await DemoHarness.create();

    // --- ask ---------------------------------------------------------------
    await h.coordinator.toggleListening();
    assert.equal(h.coordinator.isListening(), true);
    h.coordinator.handlePartial('hey macros');
    h.coordinator.handleTranscript('Hey Macros, what should I eat?');
    assert.deepEqual(h.intents, ['request_guidance']);
    assert.equal(h.coordinator.isListening(), false);

    // --- first answer ------------------------------------------------------
    const ANSWER = 'Chicken breast would help.';
    h.guidanceArrives('env-1', ANSWER, ['chicken@v1', 'yogurt@v1']);
    await h.settle();
    assert.equal(h.providerCalls.length, 1);
    assert.equal(h.played.length, 1);

    const idA = h.played[0]!.id;
    h.coordinator.handlePlaybackStart(idA);
    assert.equal(h.coordinator.isSpeaking(), true);

    // Re-renders while the answer is on screen must not replay it.
    h.render(); h.render(); h.render();
    await h.settle();
    assert.equal(h.providerCalls.length, 1, 'no duplicate provider call');
    assert.equal(h.played.length, 1, 'no duplicate utterance');

    h.coordinator.markSpeechFinished(idA);
    assert.equal(h.coordinator.isSpeaking(), false, 'the orb returns to idle');

    // --- choose, weigh, log -------------------------------------------------
    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('option one');
    assert.deepEqual(h.intents.slice(-1), ['choose:chicken@v1']);

    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('log it');
    assert.deepEqual(h.intents.slice(-1), ['log']);

    // --- ask again ----------------------------------------------------------
    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('Hey Macros, what should I eat?');
    assert.equal(h.intents.filter((i) => i === 'request_guidance').length, 2);

    /**
     * The decisive case. A new envelope carrying the SAME sentence in the SAME
     * phase — which is exactly what a repeated question can produce, and what
     * silently failed before.
     */
    h.guidanceArrives('env-2', ANSWER, ['chicken@v1']);
    await h.settle();
    assert.equal(h.providerCalls.length, 2, 'the second answer must be requested');
    assert.equal(h.played.length, 2, 'the second answer must be spoken');
    assert.notEqual(h.played[1]!.id, idA, 'a distinct utterance identity');

    h.coordinator.handlePlaybackStart(h.played[1]!.id);
    assert.equal(h.coordinator.isSpeaking(), true);
    h.coordinator.markSpeechFinished(h.played[1]!.id);
    assert.equal(h.coordinator.isSpeaking(), false);

    // Nothing spoke natively at any point: premium succeeded throughout.
    assert.deepEqual(h.spoken, []);
  });

  test('premium failure falls back once, and the flow continues', async () => {
    const h = await DemoHarness.create();
    h.premiumOutcome = 'fail';

    h.guidanceArrives('env-1', 'Chicken breast would help.', ['chicken@v1']);
    await h.settle();
    assert.deepEqual(h.spoken, ['Chicken breast would help.']);
    assert.equal(h.played.length, 0);
    assert.equal(h.coordinator.isSpeaking(), true, 'native speech is audible at once');

    h.coordinator.markSpeechFinished(null);
    assert.equal(h.coordinator.isSpeaking(), false);

    // The second envelope still works after a fallback.
    h.premiumOutcome = 'ok';
    h.guidanceArrives('env-2', 'Chicken breast would help.', ['chicken@v1']);
    await h.settle();
    assert.equal(h.played.length, 1);
    assert.equal(h.spoken.length, 1, 'the fallback did not repeat');
  });

  test('no premium transport at all still speaks every envelope once', async () => {
    const h = await DemoHarness.create(false);
    h.guidanceArrives('env-1', 'Answer.', ['a@v1']);
    await h.settle();
    h.render(); h.render();
    assert.deepEqual(h.spoken, ['Answer.']);

    h.guidanceArrives('env-2', 'Answer.', ['a@v1']);
    await h.settle();
    assert.equal(h.spoken.length, 2);
  });

  test('a stale premium response after a new envelope is discarded', async () => {
    const h = await DemoHarness.create();
    h.deferPremium();

    h.guidanceArrives('env-1', 'First answer.', ['a@v1']);
    await h.settle();
    assert.equal(h.played.length, 0, 'still in flight');

    // The user asks again before the first response lands.
    h.releasePremium();
    h.guidanceArrives('env-2', 'Second answer.', ['b@v1']);
    await h.settle();

    // Only the current envelope's audio may play.
    assert.equal(h.played.length, 1);
    assert.equal(h.providerCalls.length, 2);
  });

  test('an interruption stops speech and starts listening', async () => {
    const h = await DemoHarness.create();
    h.guidanceArrives('env-1', 'Answer.', ['a@v1']);
    await h.settle();
    h.coordinator.handlePlaybackStart(h.played[0]!.id);
    assert.equal(h.coordinator.isSpeaking(), true);

    await h.coordinator.toggleListening();
    assert.equal(h.coordinator.isListening(), true);
    assert.equal(h.coordinator.isSpeaking(), false);
    // Interrupting must not resurrect the sentence in another voice.
    assert.deepEqual(h.spoken, []);
  });

  test('a stale completion cannot silence the current answer', async () => {
    const h = await DemoHarness.create();
    h.guidanceArrives('env-1', 'First.', ['a@v1']);
    await h.settle();
    const idA = h.played[0]!.id;

    h.guidanceArrives('env-2', 'Second.', ['b@v1']);
    await h.settle();
    const idB = h.played[1]!.id;

    h.coordinator.handlePlaybackStart(idB);
    h.coordinator.markSpeechFinished(idA);
    assert.equal(h.coordinator.isSpeaking(), true, 'B keeps speaking');
    h.coordinator.markSpeechFinished(idB);
    assert.equal(h.coordinator.isSpeaking(), false);
  });

  test('unmount stops audio and refuses a late response', async () => {
    const h = await DemoHarness.create();
    h.deferPremium();
    h.guidanceArrives('env-1', 'Answer.', ['a@v1']);
    await h.settle();

    h.coordinator.dispose();
    h.releasePremium();
    await h.settle();

    // Nothing may reach the player after the screen is gone.
    assert.equal(h.played.length, 0);
    assert.equal(h.spoken.length, 0);
  });

  test('the wake phrase never changes which intent is routed', async () => {
    const h = await DemoHarness.create();
    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('what should I eat?');
    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('Hey Macros, what should I eat?');
    await h.coordinator.toggleListening();
    h.coordinator.handleTranscript('Hey, Macros, what should I eat?');
    assert.deepEqual(h.intents, [
      'request_guidance', 'request_guidance', 'request_guidance',
    ]);
  });

  test('the wake acknowledgement is once per session, every session', async () => {
    const h = await DemoHarness.create();
    await h.coordinator.toggleListening();
    assert.equal(h.coordinator.handlePartial('hey macros'), true);
    assert.equal(h.coordinator.handlePartial('hey macros what'), false);

    h.coordinator.handleTranscript('hey macros what should i eat');
    await h.coordinator.toggleListening();
    assert.equal(h.coordinator.handlePartial('hey macros'), true);
  });

  test('the waveform settles when the transcript arrives', async () => {
    const h = await DemoHarness.create();
    await h.coordinator.toggleListening();
    for (let i = 0; i < 5; i += 1) h.coordinator.handleLevel(9);
    assert.ok(h.coordinator.currentLevel() > 0);

    h.coordinator.handleTranscript('what should i eat');
    assert.equal(h.coordinator.currentLevel(), 0, 'the microphone waveform ends');
  });
});
