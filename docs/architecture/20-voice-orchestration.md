# 20 — MVP-1 Voice Orchestration

> **MVP-1 VOICE ORCHESTRATION CONTRACT — ENGINEERING CLOSED.**
> **MICROPHONE / STT / TTS INTEGRATION — EXPLICITLY PENDING.**
>
> This is not a production voice system. No microphone, wake word, speech-to-text,
> text-to-speech, cloud voice service or LLM is integrated. Everything here is
> deterministic and runs offline.

## 1. The two rules

> **VOICE ORCHESTRATION IS NOT A NUTRITION SOURCE.**
>
> **NO LLM-GENERATED NUTRITION IS PERMITTED.**

Every number voice speaks was produced by the nutrition, macro or energy engines
and read out of existing application state. The voice layer phrases values; it
never originates them.

## 2. What voice owns

Transcript normalization, intent parsing, response phrasing, and spoken number
formatting.

## 3. What voice does NOT own

Nutrition calculation · food identity · product selection · weight capture ·
logging · dashboard totals · profile · goals · persistence. It owns **no state
machine**: legal next actions are derived from `TabletAppController`, so voice
and touch cannot drift apart.

## 4. The seam

```
audio → [STT, not built] → transcript → parseVoiceUtterance() → VoiceIntent
      → existing application intent → VoiceResponse → [TTS, not built] → audio
```

Audio never enters the domain. `VoiceUtterance` carries a transcript, an arrival
instant and the subject — nothing else.

## 5. Intent → application mapping

| Voice intent | Existing application intent |
|---|---|
| `search_food` | `beginAddFood()` + `searchFood(query)` |
| `select_option` | `selectOption(label)` |
| `request_stable_weight` | `requestStableWeight()` |
| `manual_weight` | `enterManualWeight(grams)` |
| `confirm_log` | `confirmFoodLog()` |
| `cancel` | `cancelFoodFlow()` |
| `ask_consumed` / `ask_remaining` / `ask_macros` | reads `getState().dashboard` |
| `repeat_options` / `help` | reads `getState().addFood` |

**Nothing was duplicated.** Every intent maps to a method that already existed
for touch.

## 6. Parser

Deterministic grammar behind a `VoiceParser` interface, so a richer NLU can
replace it without any domain contract changing. PURE: no clock, no randomness,
no repository, no network, no LLM — enforced by the purity checker.

Four outcomes: `understood` · `needs_clarification` · `unsupported` · `invalid`.

## 7. Refusals — the safety surface

| Utterance | Behaviour |
|---|---|
| "maybe option A or B" | `ambiguous_option` — selects **neither** |
| "log something" | `no_food_named` — invents no food |
| "200 calories of oats" | `quantity_target_unsupported` — never reverse-calculates a portion |
| "I'm having yogurt" | searches; picks **no** product and **no** quantity |
| "3 ounces" / "1 cup" | `unsupported_unit` — no density assumption |
| "0 grams" / "-50 grams" | `weight_not_positive` |
| "99999 grams" | `weight_out_of_range` |
| unknown food | not-found; manufactures nothing |

Ambiguity is checked **before** any selection, so a two-candidate utterance can
never resolve. Even a single search hit is offered rather than auto-selected.

## 8. State derived, not duplicated

"Option B" with no live options resolves nothing. A stale label after a new
search cannot select the previous result. "Log it" before selection or before
weight capture is refused — voice cannot bypass product identity or the stable-
candidate policy. "Weigh it" delegates to the existing capture intent, so an
unsettled scale is never read as a final weight.

## 9. Duplicate commands

A repeated "log it" against a completed flow is acknowledged, not re-submitted;
underneath, the application's single `submissionId` per logical submission makes
a duplicate log impossible. Proven with three consecutive confirmations.

## 10. User isolation

An utterance whose subject differs from the active user is refused with zero
side effects. Switching users clears the flow, so A's selection cannot become
B's, A's option context does not survive, and B's dashboard answers report B's
day. Catalog facts are shared; history and totals are not.

## 11. Numeric formatting

`speakGrams`, `speakKcal` and `speakGramsOf` round for speech only. The response
carries exact domain values in `data`, and a test proves a 247 g log stores
407.55 kcal rather than the spoken 408.

## 12. Response model

`informational` · `options` · `review` · `success` · `clarification` · `error` —
structured so TTS, tablet text and accessibility output can render the same
outcome, with presentation wording separate from authoritative values.

## 13. Branded compatibility

"Add Demo Brand oats" → options → "Option A" → 100 g → **375 kcal from the
normal nutrition engine** → "log it" → the exact branded `ProductVersion` is
pinned. There is **no branded-specific voice nutrition path**; a test asserts the
branded and generic routes produce identical arithmetic.
