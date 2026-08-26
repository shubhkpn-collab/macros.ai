# 22 — Assistant Brain and Trusted Tool Router

> **MVP-1 ASSISTANT BRAIN + TRUSTED TOOL ROUTER — ENGINEERING CLOSED.**
> **REAL AI PROVIDER / STT / TTS — PENDING RUNTIME INTEGRATION.**
>
> No OpenAI, Anthropic or Gemini SDK. No network, no API key, no model
> selection. This milestone defines the boundary so a provider can be attached
> later without any domain behaviour changing.

## 1. The rule

> **A model may interpret LANGUAGE. It may never become the authority for food
> identity, weight, nutrition, macros, energy, logging, user identity or
> database access.**

Everything an interpreter returns is **untrusted data** — a proposal about what
the user probably meant, never an instruction and never a value the product
repeats back as fact.

## 2. The path

```
transcript
  → VoiceDeliveryGuard        (session, turn, replay, flow)
  → DeterministicVoiceParser  FAST PATH
      understood        → execute directly
      invalid           → HARD REFUSAL, model never consulted
      needs_clarification → clarify, model never consulted
      unsupported       → AssistantInterpreter
  → IntentProposal            UNTRUSTED
  → strict validator          fails CLOSED
  → trusted tool router       explicit allowlist
  → TabletAppController       the same intents touch uses
  → authoritative result → VoiceResponse
```

The router adds **no capability**: a model can reach exactly the surface a user
can reach by tapping, and no more.

## 3. When the model is consulted

Only for `unsupported` phrasing — language the grammar cannot cover. Notably
**not** consulted for:

- **`invalid`** — negative weight, unsupported unit, empty transcript. A hard
  safety refusal is final; a model may not argue it into acceptance.
- **`needs_clarification`** — "option A or B", "log something". The user named
  two things or nothing, and a model guessing between them is exactly the
  overreach the clarification exists to prevent.
- **`understood`** — already safe and free. Re-deciding would only add a way to
  get it wrong.

## 4. Minimum context

The interpreter receives: transcript, app phase, current option labels and
display names, selected food's display name, whether a weight exists, and the
allowed actions. It does **not** receive food-log history, dashboard numbers,
product ids, repository objects, rows, SQL, credentials, or anything belonging
to another user — verified by tests that assert the serialized context contains
no ids, no nutrition numbers and no trace of the other user.

## 5. The closed registry

Eleven tools, each with an explicit `stateChanging` flag and an explicit
argument allowlist. A proposal names a tool by string; that string is looked up
in the registry and **nowhere else**. There is no `controller[name]()` anywhere
in the assistant path — dynamic dispatch on model-supplied text is how a
language model becomes a remote code execution primitive. Enforced by a test
that greps the source.

## 6. What the validator refuses

Fails **closed** — no best-guess path exists.

| Attempt | Outcome |
|---|---|
| Unknown tool (`delete_database`, `switchActiveUser`) | `unknown_tool` |
| `productVersionId`, `barcode`, `gtin` | `prohibited_argument` |
| `calories`, `protein`, `tdee`, `bmr`, `tef`, `balance` | `prohibited_argument` |
| `userId` / another user's state | `prohibited_argument` |
| `sql`, `url`, `path`, `exec`, `eval` as argument names | `prohibited_argument` |
| SQL / URL / filesystem payload inside a value | `injection_payload` |
| Unknown argument on a known tool | `unknown_argument` |
| Two state-changing actions in one turn | `multiple_state_changing` |
| Option label not in the CURRENT flow | `option_not_current` |
| Action not available in the current phase | `action_not_allowed_here` |

Authority fields are refused **by name, before any value is examined**.

## 7. Numeric evidence — the model cannot invent a weight

"I'm having chicken" plus a proposed `manual_weight: 200` is a fabricated
quantity that would flow straight into a food log. So the figure is **re-derived
from the original transcript** by the deterministic parser, and the model's
value is accepted only if it matches what the user actually said. A proposal
that contradicts the transcript is rejected; the accepted value is always the
transcript's, never the model's.

Units remain grams. The model cannot convert ounces, cups or millilitres —
there is no verified conversion policy, so the refusal stands.

## 8. One state-changing action per turn

A single turn may perform at most one state-changing action. The chain —
search, select, guess a weight, log it — cannot be hidden inside one proposal.
`search → options → explicit user selection → weight → review → explicit
confirmation` is preserved exactly.

## 9. Failure and offline behaviour

An interpreter that throws, returns `null`, returns garbage, returns a non-array
`proposals`, returns nothing, or reports itself unavailable all degrade to the
same safe clarification with **zero mutation** — asserted by comparing full
serialized app state before and after.

With **no interpreter at all**, the full deterministic flow still runs end to
end: search → option → weight → log. Known commands never depend on a cloud
model.

## 10. Trace

`AssistantTrace` records path (`deterministic` / `assistant_fallback` /
`assistant_unavailable`), parser version, interpreter version, proposal summary,
validation outcome and executed intent. Engineering diagnostics only —
non-authoritative, not persisted, no analytics, no transcripts in the database.

## 11. Synthetic data honesty

The catalog remains **0 real USDA records and 0 approved real branded records**.
All assistant tests use synthetic fixtures, and nothing in the assistant path
presents them as verified commercial products.

## 12. Defects this milestone caught

- **Validator ordering.** A proposal supplying `calories` was being reported as
  "not allowed here" rather than as an attempt to supply authority. Both refuse,
  but the milder reason masked what was actually tried. Context is now checked
  last.
- **Spoken negation.** The parser read "minus 50 grams" as **positive 50** —
  STT writes negation as a word, not a `-` glyph, so the earlier sign fix did
  not cover it. Same bug class, different surface.
