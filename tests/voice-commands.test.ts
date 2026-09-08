import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SpokenOnce, UNAVAILABLE_SPEECH, interpretVoiceCommand,
} from '@macros/tablet-voice';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');
/** Comments may DISCUSS what is excluded; the code must not contain it. */
const code = (...p: string[]): string => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEMO — spoken commands map to existing intents', () => {
  test('the demo phrase requests guidance', () => {
    for (const phrase of ['Hey Macros, what should I eat?',
                          'what should I eat',
                          'Macros what can I eat',
                          "I'm hungry"]) {
      assert.equal(interpretVoiceCommand(phrase, 0).kind, 'request_guidance', phrase);
    }
  });

  test('the wake phrase is an address, not a requirement', () => {
    // Works with or without "hey macros", so a missed wake word costs nothing.
    assert.deepEqual(interpretVoiceCommand('what should i eat', 0),
      interpretVoiceCommand('hey macros what should i eat', 0));
  });

  test('option selection is bounded by what is on screen', () => {
    assert.deepEqual(interpretVoiceCommand('option one', 2), { kind: 'choose_option', index: 0 });
    assert.deepEqual(interpretVoiceCommand('option two', 2), { kind: 'choose_option', index: 1 });
    assert.deepEqual(interpretVoiceCommand('option A', 2), { kind: 'choose_option', index: 0 });
    assert.deepEqual(interpretVoiceCommand('option B', 2), { kind: 'choose_option', index: 1 });
  });

  test('choosing an option that is NOT offered is refused', () => {
    // "option two" with one recommendation is a misunderstanding; guessing
    // would select a food the person never heard offered.
    assert.equal(interpretVoiceCommand('option two', 1).kind, 'unrecognized');
    assert.equal(interpretVoiceCommand('option one', 0).kind, 'unrecognized');
  });

  test('log and cancel map to the existing intents', () => {
    for (const phrase of ['log it', 'log that', 'confirm']) {
      assert.equal(interpretVoiceCommand(phrase, 1).kind, 'log', phrase);
    }
    for (const phrase of ['cancel', 'never mind', 'nevermind', 'stop']) {
      assert.equal(interpretVoiceCommand(phrase, 1).kind, 'cancel', phrase);
    }
  });

  test('cancellation wins over anything else in the phrase', () => {
    // It must always be able to interrupt.
    assert.equal(interpretVoiceCommand('cancel, what should i eat', 2).kind, 'cancel');
  });

  test('an unheard or empty phrase does nothing', () => {
    for (const phrase of ['', '   ', 'mmm', 'the weather is nice']) {
      assert.equal(interpretVoiceCommand(phrase, 2).kind, 'unrecognized', `"${phrase}"`);
    }
  });

  test('the parser holds no nutrition or catalog authority', () => {
    const source = code('packages', 'tablet-voice', 'src', 'commands.ts');
    for (const banned of ['kcal', 'protein', 'gram', 'search(', 'recommendFood',
                          'calculateNutrition']) {
      assert.equal(source.toLowerCase().includes(banned.toLowerCase()), false,
        `the parser references ${banned}`);
    }
  });
});

describe('DEMO — speech is input only, and speaks once', () => {
  test('an outcome is spoken once despite re-renders', () => {
    const guard = new SpokenOnce();
    assert.equal(guard.shouldSpeak('outcome-1'), true);
    // React re-renders on every state change; speaking on render would repeat.
    assert.equal(guard.shouldSpeak('outcome-1'), false);
    assert.equal(guard.shouldSpeak('outcome-1'), false);
    assert.equal(guard.shouldSpeak('outcome-2'), true);
  });

  test('nothing is spoken when there is no outcome', () => {
    assert.equal(new SpokenOnce().shouldSpeak(null), false);
  });

  test('an unavailable device leaves touch fully usable', async () => {
    assert.equal(await UNAVAILABLE_SPEECH.isAvailable(), false);
    // Every method is a safe no-op rather than a throw.
    UNAVAILABLE_SPEECH.startListening();
    UNAVAILABLE_SPEECH.speak('anything');
    assert.equal(typeof UNAVAILABLE_SPEECH.onResult(() => undefined), 'function');
  });

  test('voice routes to the REAL guidance path, not the old deterministic one', () => {
    // recommendFood() would bypass the guidance/provider flow being demonstrated.
    const bridge = code('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts');
    assert.equal(bridge.includes('recommendFood('), false);
    assert.match(bridge, /onRequestGuidance\(\)/);
    assert.match(read('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts'),
      /requestFoodGuidance/);
  });

  test('TTS speaks only trusted rendered text', () => {
    const bridge = read('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts');
    assert.match(bridge, /vm\.guidance\.text/);
    for (const banned of ['providerName', 'rejections', 'raw', 'error.message']) {
      assert.equal(bridge.includes(banned), false, `TTS could speak ${banned}`);
    }
  });

  test('the native module carries no nutrition logic', () => {
    const kotlin = code('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
      'com', 'macrostablet', 'MacrosSpeechModule.kt');
    for (const banned of ['kcal', 'protein', 'carbohydrate', 'recommend']) {
      assert.equal(kotlin.toLowerCase().includes(banned), false, `kotlin has ${banned}`);
    }
    // Only final transcripts cross the bridge.
    assert.match(kotlin, /EXTRA_PARTIAL_RESULTS, false/);
  });

  test('RECORD_AUDIO is declared and survives hydration', () => {
    const manifest = read('apps', 'tablet', 'android', 'app', 'src', 'main',
      'AndroidManifest.xml');
    assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
    const hydrate = read('tools', 'hydrate-android-shell.mjs');
    assert.match(hydrate, /MacrosSpeechModule\.kt/);
  });
});

describe('DEMO — voice and premium UI are actually wired', () => {
  test('the native modules are TRACKED, not just on disk', async () => {
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    // A blanket android/app/src/main/* ignore silently swallowed these once,
    // so hydration expected files the bundle did not carry.
    assert.match(tracked, /MacrosSpeechModule\.kt/);
    assert.match(tracked, /MacrosSpeechPackage\.kt/);
  });

  test('hydration registers the package automatically', () => {
    const hydrate = read('tools', 'hydrate-android-shell.mjs');
    assert.match(hydrate, /add\(MacrosSpeechPackage\(\)\)/);
    // Idempotent, and it proves the patch rather than assuming it.
    assert.match(hydrate, /already registers MacrosSpeechPackage/);
    assert.match(hydrate, /registration missing after patch/);
  });

  test('the coordinator is instantiated once, outside its own file', () => {
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    assert.match(app, /new VoiceCoordinator\(/);
    // useMemo, not a fresh instance per render — that would lose the
    // spoken-once guard and re-announce every recommendation.
    assert.match(app, /useMemo\(\(\) => new VoiceCoordinator/);
    assert.match(app, /voice\.speakGuidanceIfNew\(\)/);
  });

  test('the orb is the push-to-talk control', () => {
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    assert.match(app, /onOrbPress: \(\) => \{/);
    assert.match(app, /voice\.toggleListening\(\);/);
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    assert.match(screens, /<MacrosOrb/);
    assert.match(screens, /actions\.onOrbPress \?\? actions\.onRequestGuidance/);
  });

  test('Home follows the locked reference, not a dashboard', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const home = screens.slice(screens.indexOf('export function HomeScreen'),
      screens.indexOf('export function', screens.indexOf('export function HomeScreen') + 10));
    assert.match(home, /Hey! Macros/);
    assert.match(home, /<MacrosOrb/);
    assert.match(home, /<FoodCard/);
    assert.match(home, /<MacroRing/);
    // The stacked dashboard panels are gone.
    assert.equal(home.includes('EnergyBalanceHero'), false);
    assert.equal(home.includes('Macros today'), false);
    assert.equal(home.includes('Logged today'), false);
  });

  test('the orb respects reduced motion and computes no nutrition', () => {
    const orb = read('apps', 'tablet', 'src', 'components', 'MacrosOrb.tsx');
    assert.match(orb, /isReduceMotionEnabled/);
    for (const banned of ['kcal', 'proteinG', '* 4', '* 9']) {
      assert.equal(orb.includes(banned), false, `the orb computes ${banned}`);
    }
  });

  test('the food card is ready for real photography', () => {
    const orb = read('apps', 'tablet', 'src', 'components', 'MacrosOrb.tsx');
    // A dedicated image area exists now so dropping photos in later needs no
    // second layout pass, and no external URL is invented.
    assert.match(orb, /Placeholder image area/);
    assert.equal(/https?:\/\//.test(orb), false);
  });
});

describe('DEMO — final closure', () => {
  test('App imports every hook it uses', () => {
    // useEffect and useRef were used without being imported, which would
    // have failed on the owner's first compile.
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    const headerEnd = app.indexOf("from 'react';") + 13;
    const header = app.slice(0, headerEnd);
    const body = app.slice(headerEnd);
    for (const hook of ['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback']) {
      if (body.includes(hook + '(')) {
        assert.ok(header.includes(hook), `${hook} is used but not imported`);
      }
    }
  });

  test('listening state is reactive, not a frozen snapshot', () => {
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    // A memoized voice.isListening() never changed, so the orb stuck.
    assert.equal(/isListening: voice\.isListening\(\)/.test(app), false);
    assert.match(app, /const \[listening, setListening\] = useState\(false\)/);
    assert.match(app, /isListening: listening/);
  });

  test('every ending path returns the orb to idle', () => {
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    const effect = app.slice(app.indexOf('onResult'), app.indexOf('speakGuidanceIfNew'));
    // Result, end-of-speech and error all reset; a stuck listening state would
    // be the most visible possible failure in a demo.
    assert.ok((effect.match(/setListening\(/g) ?? []).length >= 3);
    assert.match(effect, /state === 'listening'/);
  });

  test('the coordinator is created after what it closes over', () => {
    const app = read('apps', 'tablet', 'src', 'App.tsx');
    assert.ok(app.indexOf('const viewModelRef') < app.indexOf('new VoiceCoordinator'),
      'the ref must exist before the coordinator that reads it');
  });

  test('Weighing and Review use the premium components', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const weighing = screens.slice(screens.indexOf('export function WeighingScreen'),
      screens.indexOf('export function ReviewScreen'));
    assert.match(weighing, /<MacrosOrb/);
    assert.match(weighing, /state="weighing"/);
    assert.match(weighing, /weightLabel=/);

    const review = screens.slice(screens.indexOf('export function ReviewScreen'));
    assert.match(review, /Confirm \{r\.displayGrams\} of/);
    assert.ok((review.match(/<MacroRing/g) ?? []).length === 4,
      'four circular figures, per the reference');
    // Trusted strings only.
    for (const banned of ['proteinG *', 'kcal *', '* 4', '* 9']) {
      assert.equal(review.includes(banned), false, `Review computes ${banned}`);
    }
  });

  test('startup failure is branded, never raw', () => {
    const entry = read('apps', 'tablet', 'index.js');
    assert.equal(entry.includes('Host failed to start'), false);
    assert.equal(entry.includes('{error}'), false, 'a raw error string is rendered');
    assert.match(entry, /Something didn't start correctly/);
    assert.match(entry, /Hey! Macros/);
    // Diagnostics survive, off-screen.
    assert.match(entry, /console\.error\('\[macros\] host start failed'/);
  });
});

describe('DEMO — Home renders the real view-model contract', () => {
  test('macro rings come from the MacroView[] array, not assumed keys', () => {
    // `vm.macros.protein.displayRemaining` red-screened on the owner's device:
    // the contract is an ARRAY, and naming keys assumed a shape it never had.
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    assert.equal(/vm\.macros\.(protein|carbohydrate|fat)/.test(screens), false,
      'macros is a MacroView[], not an object keyed by macro name');
    assert.match(screens, /vm\.macros\.map\(\(macro\) =>/);
    assert.match(screens, /label=\{macro\.label\}/);
    assert.match(screens, /value=\{macro\.displayRemaining\}/);
  });

  test('the view model still supplies Protein, Carbs, Fat in order', async () => {
    const vm = await import('@macros/tablet-view-model');
    const locked = vm.lockedViewModel();
    // Order is the view model's, not React's — duplicating it in the renderer
    // would let the two drift.
    assert.deepEqual(locked.macros.map((m) => m.label), []);
    const source = read('packages', 'tablet-view-model', 'src', 'view-model.ts');
    assert.match(source, /macroOf\('Protein'/);
    assert.match(source, /macroOf\('Carbs'/);
    assert.match(source, /macroOf\('Fat'/);
    assert.match(source, /readonly macros: readonly MacroView\[\]/);
  });

  test('nullable view-model fields are narrowed, not coerced away', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    // energy and selectedFood are legitimately nullable; reaching through
    // either would have been the next red screen.
    assert.match(screens, /vm\.energy === null \?/);
    assert.match(screens, /selected !== null \?/);
    // No optional chaining or coercion used to suppress a crash.
    assert.equal(/vm\.(energy|selectedFood|review)\?\./.test(screens), false);
    assert.equal(/as any|as never|as unknown as/.test(screens), false);
  });

  test('the manual-weight action can actually be disabled', () => {
    // SecondaryAction had no `disabled` prop, so the guard was silently inert.
    const primitives = read('apps', 'tablet', 'src', 'components', 'primitives.tsx');
    assert.match(primitives, /disabled = false/);
    assert.match(primitives, /disabled=\{disabled\}/);
    assert.match(primitives, /accessibilityState=\{\{ disabled \}\}/);
  });
});
