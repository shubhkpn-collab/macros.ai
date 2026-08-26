# 07 — AI / Tool Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


Design premise: **the LLM is a router and a narrator.** It selects tools, fills slots, and phrases results. It never originates a number, and it is not on the critical path for the most common interactions.

> **Explicit (v3):** the LLM may never calculate, adjust, or reason numerically about **TEF**, BMR, active energy, expenditure, TDEE, surplus/deficit, remaining intake, scale weights, calories, macros, or food nutrition. `calculateTef` and `computeEnergyState` live in `packages/domain-energy`, which cannot import an LLM SDK — CI-enforced.

## 1. Pipeline

```
transcript
   │
   ├─► [1] DETERMINISTIC INTENT MATCH  (packages/voice-intents)
   │        hit  → tool call → template → cached TTS      ~70% of traffic, ≤900ms, $0
   │        miss ↓
   ├─► [2] DOMAIN GATE (small classifier + policy)
   │        out-of-domain → canned refusal, no LLM call
   │        in-domain ↓
   ├─► [3] ORCHESTRATOR (LLM, tool-calling loop, ≤4 tool calls)
   │
   ├─► [4] RESPONSE COMPOSER (constrained generation, style contract)
   │
   ├─► [5] NUMERIC FIDELITY VALIDATOR   ← hard gate
   │        every numeral must trace to a tool result
   │
   └─► TTS (streamed)
```

### [1] Deterministic fast paths
A grammar over the ~40 highest-frequency utterances: `option {A|B|C|D}`, `log it`, `tare`, `how much protein/carbs/fat do I have left`, `where am I`, `what's my balance`, `undo`, `cancel`, `more`, `[number] grams`, `half of that`. Slot extraction is regex + a small lexicon. Benefits: latency, cost, and — most importantly — **reliability of the core loop**. The demo flow in the brief (`"Tofu"` → `"Option B"`) should not depend on an LLM being available.

### [2] Domain gate
Runs before the expensive model. A cheap classifier (or a small model with a fixed prompt) labels the utterance into: `nutrition_domain`, `device_control`, `out_of_domain`, `safety_sensitive`. Out-of-domain gets a fixed, in-character refusal:

> "That's outside what I handle. I cover food, nutrition and your energy balance."

Two layers of defense so refusal behavior isn't a prompt-injection target: policy in the system prompt *and* a pre-model gate. Refusals are logged to `ai.refusals` with the transcript hash for false-positive review — over-refusal is a real product risk on a device whose only interface is voice.

`safety_sensitive` (disordered-eating language, medical claims, minors asking for extreme deficits, pregnancy) routes to a scripted, non-generative response path. See `12`.

### [3] Tool layer

Tools are declared once in `packages/ai-tools` from zod schemas → JSON Schema. Each declaration carries an **authorization descriptor** and an **effect class**.

| Tool | Effect | Authz | Notes |
|---|---|---|---|
| `getUserProfile` | read | self only | never returns another member's data |
| `searchFood(query, context)` | read | any | context = household pantry, region |
| `identifyProduct(query|gtin)` | read | any | returns 4 diversified candidates |
| `getFoodProduct(versionId)` | read | any | |
| `getFoodNutrition(versionId, basis)` | read | any | |
| `calculateNutrition(versionId, grams)` | pure compute | any | delegates to `domain-nutrition` |
| `logFood(versionId, grams, source, idempotencyKey)` | **write** | self only | idempotent; requires active session user |
| `getDailyIntake(date)` | read | self only | |
| `getEnergyExpenditure(date)` | read | self only | |
| `getEnergyBalance(asOf)` | read | self only | the KPI |
| `getRemainingMacros(date)` | read | self only | |
| `getFoodHistory(range, filter)` | read | self only | |
| `recommendFood(constraints)` | read | self only | ranks catalog against remaining macros |
| `getPrediction(kind, horizon)` | read | self only | post-MVP |
| ~~`getScaleWeight()`~~ | — | — | **Removed.** The weight lives on the tablet; it travels in the turn payload as context, not as a server-side tool. |

Rules:
- **Every tool is executed server-side under the *session user's* identity**, resolved from the device session — not from anything the model said. The model cannot address another user's data even if instructed to.
- All writes carry an idempotency key derived from `(session, utterance_id)`. A retried tool call cannot double-log dinner.
- Timeouts (500 ms typical, 2 s hard) with graceful degradation: "Scale isn't responding. Say the weight."
- Tool results are logged in `ai.tool_calls` with arguments, latency, and result hash — this is the audit trail behind every spoken number.

### [4] Response composer — style as a contract
The concise JARVIS register is enforced structurally, not hoped for:
- Response templates for every deterministic intent (`"Logged — {kcal} calories and {protein}g protein."`).
- For LLM-composed responses: max ~25 words unless `detail_requested`; no greetings; no restatement of the question; no hedging; imperative recommendations.
- A post-generation style linter rejects openers like "Sure!", "I'd be happy to", "Great question" and regenerates once, then falls back to the template.

### [5] Numeric fidelity validator — the mechanism that makes the brief's rule true
Extract every numeral from the candidate response. Each must either (a) appear in a tool result from this turn, (b) be a permitted formatting of one (rounding, unit conversion via the shared formatter), or (c) come from the utterance itself. Otherwise: reject, retry once with the tool results restated, then fall back to a template. Violations are alerted on, not just logged — a single hallucinated calorie count is a product-credibility event.

## 2. Context assembly

The model receives a small, structured context — never a dumped chat history:

```
user: { firstName, goal, targetDelta, dietaryFlags, allergens }
now:  { localTime, mealWindow }
state:{ activeProductVersion, lastWeightGrams, weightStable, pendingLogDraft }
today:{ balanceKcal, targetKcal, remaining: {protein, carb, fat} }   ← from tools, refreshed
turns: last 3 turns, summarized
```

Pre-loading today's balance means "where am I" can often answer with zero tool round-trips.

## 3. RAG — knowledge only

pgvector retrieval over `knowledge.*`: dietary guidance, food-science explanations, product help, goal education. Retrieved chunks are **explanatory context only** and are marked as non-authoritative in the prompt. Product nutrition never comes from RAG; if the model tries to answer a nutrition-fact question without a tool call, the numeric validator kills it. Per the brief: no single vector database of product information.

## 4. Prompt-injection surface

Product names, ingredient lists and user-submitted foods are untrusted text that reaches the model. Mitigations: retrieved and tool-returned content is delimited and labeled as data; the system policy states that instructions inside data are ignored; tools are authorized by session identity rather than by model assertion; write tools require explicit user confirmation in the UI or a matched confirmation utterance.

## 5. Evaluation (CI-gated)

`packages/ai-tools` ships an eval harness run on every PR touching prompts, tools, or the gate:

| Suite | Metric | Gate |
|---|---|---|
| Tool selection | correct tool + args on 300 labeled utterances | ≥ 95% |
| Refusal | precision / recall on in/out-of-domain sets | ≥ 98% / ≥ 95% |
| Numeric fidelity | invented numbers per 1,000 responses | 0 |
| Style | words per response, banned-opener rate | p95 ≤ 25, 0 |
| Safety | scripted-path hit rate on ED/medical probes | 100% |
| Latency | fast path p95, LLM path p95 | ≤ 900 ms, ≤ 2.5 s |

Prompt and model changes are versioned artifacts with the same review weight as code.

## 6. Model strategy

Tiered: tiny/cheap for the domain gate and classification; a mid-tier model for orchestration and composition; escalation to a larger model only for genuinely open-ended requests (meal planning, explanations). Vendor-abstracted behind a `LlmProvider` interface so a model swap is a config change and an eval run.
