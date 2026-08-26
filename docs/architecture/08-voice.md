# 08 — Voice Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


Voice is the primary interaction method on a device that sits next to a range hood, a running tap and a radio. Treat the audio front end as a hardware problem, not a software one.

## 1. Pipeline

```
mic array ─► AEC + beamforming + noise suppression   (DSP / SoC, always local)
          ─► WAKE WORD "Hey Macros"                  (on-device, always local)
          ─► VAD + endpointing                       (on-device)
          ─► streaming ASR                           (cloud, WSS)
          ─► intent fast path │ domain gate │ orchestrator   (07)
          ─► response text
          ─► TTS: cached phrase │ streamed synthesis
          ─► playback with barge-in
```

**No audio leaves the device before the wake word fires.** Non-negotiable for a kitchen appliance, and it is also the answer to most privacy questions.

## 2. Wake word

- On-device, small-footprint model (Picovoice Porcupine-class custom keyword, or equivalent). Runs continuously at low power.
- Tuned for **low false-accept in noise** over low false-reject: a kitchen device that wakes during a dinner-party conversation is worse than one that occasionally needs a second try.
- Target: ≤ 1 false accept per 24 h in typical kitchen noise; ≥ 95% detection at 3 m, 60 dBA background.
- A hardware **mute switch** that physically cuts mic power, with an unambiguous LED. Required for trust, and it is a hardware requirement (D-14).
- Follow-up window: after a response, the mic stays open ~5 s without requiring the wake phrase — the brief's own example ("Hey Macros." … "Tofu.") depends on this.

## 3. ASR

- Streaming, partial hypotheses used to pre-warm search: as soon as "tof…" is stable, `searchFood` is speculatively issued so results are on screen at endpoint.
- **Domain vocabulary boosting** with brand and food lexicons (Kirkland, Aldi, quinoa, tofu, Fage, halloumi) plus the household's own pantry terms. Generic ASR mis-hears brand names constantly; this is the highest-leverage accuracy work in the whole voice stack.
- Number/unit grammar biasing for "two hundred forty seven grams", "one and a half cups".
- Provider abstracted behind a `SpeechProvider` interface; on-device ASR for the fast-path grammar is a later cost optimization (`13`).

## 4. Latency budget

| Segment | Budget (p95) |
|---|---|
| Wake word detection | 200 ms |
| First ASR partial | 300 ms after speech onset |
| Endpoint detection | 400 ms after speech ends |
| Fast path: intent → tool → text | 200 ms |
| Cached TTS start | 100 ms |
| **Fast path total (speech end → audio out)** | **≤ 1,300 ms** (corrected: includes cloud-ASR finalization) |
| LLM path total | ≤ 2,500 ms |

If the LLM path exceeds ~700 ms, emit an immediate acoustic acknowledgment (a short tone or "Working.") — perceived latency is what matters, and silence reads as failure.

## 5. TTS

- Cache the top ~200 responses as pre-rendered audio ("Logged.", "Ready.", "Tared.", digit and unit fragments). Concatenative assembly covers most confirmations at near-zero latency and near-zero cost.
- Streamed neural synthesis for everything else.
- One voice identity, consistent across tablet and phone. Voice selection is a brand decision (D-17).
- Barge-in: wake word and VAD stay active during playback; user speech ducks and cancels output.

## 6. Multi-user voice on shared hardware

The unresolved question from `01/A3`. Options, in my order of preference:

1. **Explicit active-user tile** on the tablet + a spoken switch ("Hey Macros, I'm Sarah" → matches display-name lexicon, no biometrics). Session times out to a neutral state after N minutes of inactivity.
2. **Phone proximity** (BLE presence of the member's phone) as a *hint* that pre-selects but does not silently commit.
3. **PIN** for viewing detailed personal data on the shared screen.
4. **Voiceprint identification** — highest UX quality, but it is biometric data; Illinois BIPA (the user's own jurisdiction) creates written-consent, retention-schedule and private-right-of-action exposure with statutory damages. **Recommend deferring past MVP**, and treating it as a legal project with an engineering component rather than the reverse.

Whatever is chosen, the rule is: **a log is always attributed to the session's active user, and the confirmation always names them** ("Logged for Sarah — 330 calories"). Cheap, and it makes misattribution self-correcting.

## 7. Failure handling

| Failure | Behavior |
|---|---|
| ASR low confidence | "Say that again." — never guess a food |
| No search results | "No match for tofu. Try a brand." |
| Network down | Fast paths + cached pantry search work offline; response says "Offline — logged locally." |
| Scale disconnected | "Scale isn't connected. Say the weight." |
| Ambiguous multi-match | Present A/B/C/D visually and stop talking — the screen is the disambiguator |
| Repeated failure (3×) | Fall back to touch UI and say so |

## 8. Privacy controls

- Audio retention **off by default**; opt-in per household for quality improvement, with per-user consent recorded in `identity.consents`.
- Transcripts stored hashed for eval sampling unless retention is opted into.
- Wake-word false accepts discarded locally, never uploaded.
- A visible recording indicator whenever the mic is streaming.
- Children in the household: no voice data retention under any consent setting (`12`).
