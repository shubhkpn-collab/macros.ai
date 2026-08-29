# 35 — UX-1 Premium Tablet Appliance Experience

> **UX-1 — ENGINEERING AUTHORED; OWNER VISUAL ACCEPTANCE PENDING**
>
> Visual quality cannot be closed from static tests. These notes describe intent
> and the rules that are enforced; the screenshots decide the rest.

## 1. What this milestone is

RT-2 proved the core loop runs on real Android. It was functionally correct and
looked like a developer app: dead space, weak hierarchy, generic rectangles, and
raw values such as `-1822.1109375` and `48.333333333333336 g` on screen.

UX-1 turns that into one coherent appliance surface. The customer should feel
*"I am using MACROS.AI"*, not *"I am using an Android tablet app"*.

## 2. Formatting is a presentation concern

The float artifacts were not a maths bug — the engines were right. They were a
missing layer. `packages/tablet-view-model/src/format.ts` is now the only place
numbers become strings:

| Input | Output |
|---|---|
| `-1822.1109375` | `-1,822` |
| `48.333333333333336` | `48.3 g` |
| `62.0000001` | `62 g` |
| `-1505` | `1,505 kcal deficit right now` |
| `0` | `At maintenance right now` |

Rules that matter:

- **Domain precision is untouched.** The view model carries the authoritative
  number alongside the formatted string; rounding never feeds back into a
  calculation.
- **The sign is meaning.** A deficit and a surplus must not render alike, and
  `Math.round(-0.2)` producing `-0` must not print as `-0`.
- **Effectively-whole grams render whole.** Accumulated floating-point addition
  rarely lands exactly on an integer even when the true value is one.
- **Progress clamping is layout only.** An overshoot still reads honestly in the
  numbers beside the bar, even though the bar cannot draw past its track.

## 3. Design tokens

`tokens.ts` is the single presentation authority: canvas, surfaces, borders,
text tiers, accent, warning, danger, disabled; a 4pt spacing scale; radii;
a typography scale from `productLabel` to `energyHero` (116pt); 72dp minimum
touch targets; motion durations; restrained elevation.

Deep charcoal canvas, warm off-white text, one fresh green accent. Amber and red
are reserved strictly for warning and failure — spending them elsewhere would
make a real problem unremarkable. A test fails the build on any hard-coded hex
in a component.

## 4. Screens

**Home** — energy hero dominant inside a raised surface, semantic line beneath,
projection quieter still; three balanced macro modules; *Add food* as a pill,
not a form button; logged-today list only when trusted state exists.

**Search** — a calm fallback, explicitly secondary to voice
(*"Or say Hey Macros when voice is available"*), large field, keyboard submit,
trusted error copy.

**Options** — Option A/B/C in a bordered tile, food name at metric size,
preparation state in a pill that turns amber when it is what distinguishes two
candidates. Raw and cooked chicken differ by roughly a third in energy; quietly
picking the wrong one is the worst mistake this screen could make.

**Weighing** — the signature screen. The selected food is named at the top, so
the weight is never floating free of what is being weighed. `selectedFood` was
added to the view model precisely because deriving identity from `review` left
the screen saying "Selected food —" throughout weighing.

**Review** — identity first, then a hero card with weight, large energy and the
three macros. *Log food* dominant.

**Logged** — a spring-scaled check, "Logged", the food and weight, then the
existing application-safe return home. Reduced-motion safe.

**Locked / switch / offline / error** — same system. Locked is built without
reading app state at all. A stays named while B authenticates. Offline says
"waiting to sync", never "saved".

## 5. Architecture

```
domain / application state  →  tablet-view-model (+ format)  →  React Native
```

Components render formatted strings and semantic labels. They do not calculate
kcal, macros or balance, do not call repositories, and do not import the
engines. The renderer purity guard enforces it.

## 6. What UX-1 does not do

No kiosk/launcher lockdown, BLE, microphone, STT/TTS, production Supabase host,
AU-1/AU-2, billing, onboarding, recipes, history or micronutrient screens.
**No new dependencies** — React Native core only.
