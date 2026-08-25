# apps/tablet — MVP-0 renderer

> **RENDERER EXECUTION PENDING TOOLCHAIN AVAILABILITY.**
>
> React Native, Expo, Metro and the RN testing libraries are **not installed**,
> and there is no network egress to install them. No renderer source lives here
> yet, because writing `.tsx` against packages that cannot resolve would produce
> code that neither typechecks nor runs — a fake app, not a real one.
>
> What was NOT done, deliberately: no invented React Native packages, no
> hand-written framework type declarations, no pivot to web, no random
> dependencies pulled in.

## What exists instead

The **entire application layer is complete and tested** in
`packages/tablet-app-core`. When RN tooling is available, the renderer is a thin
adapter: components call controller intents and render `AppState`. No business
logic moves into components, because none of it lives there now.

## Screen specifications

Four primary screens. Each is a pure projection of `AppState`.

### 1. Dashboard — `state.dashboard`

North-star hierarchy, largest to smallest:

```
MACROS.AI                         [active user — always visible]

CURRENT            energy.currentBalanceKcal        ← hero
TARGET EOD         energy.targetDeltaKcal
EAT TO TARGET      energy.remainingIntakeKcal       ← the actionable number

Protein  macros.remainingProteinG g left
Carbs    macros.remainingCarbohydrateG g left
Fat      macros.remainingFatG g left

— supporting, smaller —
Consumed               intake.kcal
Expended so far        energy.expenditureSoFarKcal
Projected expenditure  energy.projectedTotalExpenditureKcal
Activity source        energy.activitySource
Energy estimate        "incomplete" when dashboard.energyIncomplete
```

- Calories consumed is **supporting**, never the hero.
- There is no PAL, and no "calories remaining" derived from one.
- `developmentDataNotice` renders as a discreet development-only strip.
- Primary action: **Add food**.

### 2. Food search — `state.addFood.results`

Each result is a large card carrying its `optionLabel`:

```
A   Chicken breast, cooked          B   Chicken breast, raw
    Cooked                              Raw
```

Preparation state is shown whenever `preparationStateDisambiguates` is true.
`error.code === 'no_results'` renders as plain text; nothing is auto-selected.

### 3. Weight — `state.scale`

Consumer-facing text only, from `scale.message`: *Scale not connected* /
*Place food on scale* / *Stabilizing…* / *Ready to capture* / *Remove food to
continue*. Current reading from `scale.displayGrams`.

Actions: **Use this weight** (`requestStableWeight`) and **Enter weight
manually** (`enterManualWeight`).

Low-level protocol controls (tare, fault injection, disconnect) live in a
**hidden development panel**, never the normal flow.

### 4. Review — `state.addFood.preview`

```
Chicken breast, cooked
200 g · from scale

330 kcal
62 g protein · 0 g carbs · 7.2 g fat
```

Actions: **Log food** (`confirmFoodLog`) and **Cancel** (`cancelFoodFlow`).

## Visual direction

Black / charcoal / grey, high contrast, generous whitespace, portrait-first.
One number dominates each screen. No rainbow macro rings, no dense cards, no
Material demo styling — it should read as an appliance.

## Interaction requirements

- Touch targets ≥ 64 dp; primary actions ≥ 88 dp tall.
- Selected state is shown by border and weight, **not colour alone**.
- Energy incompleteness is a text label, not a coloured dot alone.
- Type scale: hero ≥ 72 sp, section labels ≥ 18 sp, body ≥ 16 sp.

## Component boundaries

```
apps/tablet (renderer)          → renders AppState, emits intents
packages/tablet-app-core        → ALL application behaviour
packages/domain-*               → closed deterministic domains
packages/persistence            → repository boundary
```

A component may hold layout state (scroll position, keyboard focus) and nothing
else. If a component needs to decide something, the decision belongs in the
controller.
