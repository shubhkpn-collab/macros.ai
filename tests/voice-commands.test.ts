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
    // Every method is safe rather than a throw, and starting REPORTS that it
    // could not, so the caller never waits for an event that cannot arrive.
    assert.equal(await UNAVAILABLE_SPEECH.startListening(), 'unavailable');
    UNAVAILABLE_SPEECH.speak('anything', 'utt-1');
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
    for (const banned of ['kcal', 'protein', 'carbohydrate', 'recommendFood']) {
      assert.equal(kotlin.toLowerCase().includes(banned.toLowerCase()), false,
        `kotlin has ${banned}`);
    }
    // Partial results now drive the live caption and the wake acknowledgement,
    // but only the FINAL transcript is ever acted on — see onResults.
    assert.match(kotlin, /EXTRA_PARTIAL_RESULTS, true/);
    assert.match(kotlin, /RESULTS_RECOGNITION/);
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
    // The literal now lives in the shared helper; the script calls it once and
    // COUNTS the result. Detailed behaviour is covered in
    // tests/speech-registration.test.ts.
    const hydrate = read('tools', 'hydrate-android-shell.mjs');
    assert.match(hydrate, /registerSpeechPackage\(/);
    assert.match(hydrate, /already registers MacrosSpeechPackage/);
    assert.match(hydrate, /registrations !== 1/);
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
    // The outcome is awaited now, so a refused start settles the orb instead
    // of leaving it on "Listening…".
    assert.match(app, /voice\.toggleListening\(\)\.then\(\(outcome\)/);
    assert.match(app, /setListening\(outcome === 'started'\)/);
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
    assert.match(home, /<MacroFooter/);
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
    assert.match(orb, /Image panel/);
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
    assert.match(weighing, /Current weight:/);
    assert.match(weighing, /selected=\{selected !== null && card\.productVersionId === selected\.productVersionId\}/);

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
    assert.match(screens, /value=\{macro\.displayConsumed\}/);
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
    assert.match(screens, /selected === null \?/);
    assert.match(screens, /vm\.selectedFood !== null/);
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

describe('LOCKED REFERENCE — orb, cards and macro rings', () => {
  const orb = () => read('apps', 'tablet', 'src', 'components', 'MacrosOrb.tsx');
  const screens = () => read('apps', 'tablet', 'src', 'components', 'screens.tsx');

  test('the orb is a prismatic ring, not a bordered circle', () => {
    const code = orb();
    // The reference shows concentric spectrum haloes around an empty centre.
    assert.match(code, /orbSpectrumA/);
    assert.match(code, /orbSpectrumD/);
    assert.match(code, /const haloes/);
    // The pressable itself carries no border or fill.
    assert.equal(/backgroundColor: color\.surface,\s*\n\s*alignItems: 'center', justifyContent: 'center',\s*\n\s*\}\}\s*\n\s*>/.test(code), false);
  });

  test('all four speech states share ONE component', () => {
    const code = orb();
    for (const state of ['idle', 'listening', 'thinking', 'speaking', 'weighing']) {
      assert.ok(code.includes(`'${state}'`), `missing orb state ${state}`);
    }
    // Distinguished only by intensity and tempo, per the reference.
    assert.match(code, /const INTENSITY: Record<OrbState, number>/);
    assert.match(code, /isReduceMotionEnabled/);
  });

  test('no audio-player affordance exists anywhere', () => {
    // An appliance that grows a media player stops feeling like an appliance.
    // Comments may EXPLAIN the absence; the rendered code must not contain one.
    const strip = (src: string): string => src
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const code of [strip(orb()), strip(screens())]) {
      for (const banned of ['waveform', 'Play', 'Pause', 'seek', 'OpenAI',
                            'Generating audio']) {
        assert.equal(code.includes(banned), false, `found audio control: ${banned}`);
      }
    }
  });

  test('macro rings carry their own hue, distinct from status colours', async () => {
    const tokens = await import('@macros/tablet-view-model');
    // Amber as "fat" must not be confused with amber as "warning".
    assert.notEqual(tokens.color.macroFat, tokens.color.warning);
    assert.notEqual(tokens.color.macroProtein, tokens.color.accent);
    const code = orb();
    assert.match(code, /Protein: color\.macroProtein/);
    assert.match(code, /Fat: color\.macroFat/);
    assert.match(code, /Carbs: color\.macroCarbs/);
  });

  test('only the chosen recommendation is visibly selected', () => {
    const code = screens();
    assert.match(code, /selected=\{vm\.selectedFood !== null && vm\.selectedFood\.productVersionId === c\.productVersionId\}/);
    assert.match(orb(), /borderColor: selected \? color\.textPrimary/);
  });

  test('the food card keeps a real image panel', () => {
    const code = orb();
    assert.match(code, /Image panel/);
    // No external URL is invented while photography is unavailable.
    assert.equal(/https?:\/\/[a-z]/i.test(code), false);
  });
});

describe('LOCKED REFERENCE — the orb returns to rest', () => {
  test('speaking is driven by playback, not by the guidance phase', () => {
    const code = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    // Deriving it from the phase left the orb pulsing after the sentence ended.
    assert.match(code, /actions\.isSpeaking === true \? 'speaking'/);
    assert.equal(/guidance\.phase === 'awaiting_choice'[\s\S]{0,40}'speaking'/.test(code), false);
  });

  test('listening takes priority over speaking', () => {
    const code = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const block = code.slice(code.indexOf('const orbState: OrbState'));
    assert.ok(block.indexOf('isListening') < block.indexOf('isSpeaking'));
  });

  test('every ending path clears the speaking flag', () => {
    const coordinator = read('apps', 'tablet', 'src', 'voice', 'voice-coordinator.ts');
    assert.match(coordinator, /markSpeechFinished\(speechId: string \| null = null\): void \{/);
    assert.match(coordinator, /this\.speaking = false;/);
    // The pending utterance is cleared too, so a late failure cannot re-speak.
    assert.match(coordinator, /this\.pendingText = null;/);
    // Starting to listen also stops speech, so the microphone does not hear
    // the appliance.
    assert.match(coordinator, /this\.deps\.speech\.stopSpeaking\(\);/);
    assert.match(coordinator, /this\.listening = true;/);

    const app = read('apps', 'tablet', 'src', 'App.tsx');
    assert.match(app, /onSpeechFinished\(\(speechId\) => \{/);
    // An error must rest the orb too, or a silent speaker leaves it pulsing.
    const effect = app.slice(app.indexOf('onError'), app.indexOf('offDone'));
    assert.match(effect, /markSpeechFinished\(speechId\)|markSpeechFinished\(null\)/);
  });

  test('the native module reports completion, interruption and failure', () => {
    const kotlin = read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
      'com', 'macrostablet', 'MacrosSpeechModule.kt');
    assert.match(kotlin, /UtteranceProgressListener/);
    // All endings funnel through one guarded emitter, so the raw event appears
    // once and cannot fire twice for a single utterance. Every call now carries
    // the utterance identity.
    assert.equal((kotlin.match(/emit\("MacrosSpeechDone"/g) ?? []).length, 1);
    assert.equal(/emitFinishOnce\(\)/.test(kotlin), false, 'no anonymous ending');
    assert.ok((kotlin.match(/emitFinishOnce\([a-zA-Z]/g) ?? []).length >= 4,
      'done, error, stop and interruption must all report an ending');
  });
});

describe('REFERENCE — Home follows the supplied frames', () => {
  /** The rendered JSX only — the doc comment above it describes the layout. */
  const home = (): string => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const from = screens.indexOf('export function HomeScreen');
    const body = screens.slice(from, screens.indexOf('export function', from + 10));
    return body.slice(body.indexOf('return ('))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  test('the orb sits ABOVE the greeting, compact', () => {
    const code = home();
    // The frames place the ring at the top with the title beneath it; the orb
    // is the signature here, the food cards are what the eye should land on.
    assert.ok(code.indexOf('<MacrosOrb') < code.indexOf('Hey! Macros'));
    assert.match(code, /size=\{124\}/);
  });

  test('the greeting, question, microphone and weight line are in order', () => {
    const code = home();
    const order = ['Hey! Macros', 'What are you eating today?', '<MicButton',
      'Current weight:', '<FoodCard', '<MacroFooter'];
    let last = -1;
    for (const marker of order) {
      const at = code.indexOf(marker);
      assert.ok(at > last, `${marker} is out of order`);
      last = at;
    }
  });

  test('four rings, with calories last', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const code = screens.slice(screens.indexOf('function MacroFooter'), screens.indexOf('export function HomeScreen'));
    // Consumed totals and goals come from the view model, not energy balance.
    assert.match(code, /vm\.macros\.map\(\(macro\) =>/);
    assert.match(code, /label="Calories" value=\{vm\.daily\?\.displayCalories/);
    assert.ok(code.indexOf('vm.macros.map') < code.indexOf('label="Calories"'));
  });

  test('three cards at most, the pick ringed', () => {
    // The cap is applied above the return, so this one reads the whole body.
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const from = screens.indexOf('export function HomeScreen');
    const body = screens.slice(from, screens.indexOf('export function', from + 10));
    assert.match(body, /\.slice\(0,\s*3\)/);
    const code = home();
    assert.match(code, /selected=\{vm\.selectedFood !== null && vm\.selectedFood\.productVersionId === c\.productVersionId\}/);
    const orb = read('apps', 'tablet', 'src', 'components', 'MacrosOrb.tsx');
    assert.match(orb, /borderColor: selected \? color\.textPrimary/);
    assert.match(orb, /opacity: selected \? 1 : 0\.72/);
  });

  test('the weight line appears only when the scale has one', () => {
    // An empty "Current weight:" would read as a fault, not a state.
    assert.match(home(), /vm\.scale\.displayWeight === null \?/);
  });

  test('no dashboard hierarchy crept back in', () => {
    const code = home();
    for (const banned of ['Daily Totals', 'EnergyBalanceHero', 'Logged today']) {
      assert.equal(code.includes(banned), false, `Home shows ${banned}`);
    }
  });
});
