# 12 — Security & Privacy Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


Threat model in one line: **an always-listening microphone and a shared screen in a family kitchen, holding health-adjacent data for multiple people who live together.** The interesting adversary is not a remote attacker — it is a household member, and the interesting failure is not a breach but a leak across the dinner table.

## 1. Data classification

| Class | Examples | Handling |
|---|---|---|
| **Sensitive-personal** | weight, body fat, goals, energy balance, food logs, wearable activity | Per-user RLS, never on a shared screen without an active session, deletable per-user |
| **Biometric** | voiceprints (if ever built) | Written consent, retention schedule, jurisdiction review — see §6 |
| **Household** | household name, device, retailer preferences, pantry | Visible to all members |
| **Operational** | device telemetry, crash logs, latency traces | Pseudonymous, no content |
| **Public** | catalog product data | No restriction |

## 2. Identity and access

- Supabase Auth for user identity; short-lived JWTs; refresh rotation.
- **Three principals** with separate DB roles: `app_user`, `app_device`, `app_service` (`04 §1`).
- **RLS deny-by-default on every user-scoped table.** CI rejects any migration creating such a table without a policy.
- Device tokens are distinct from user tokens. Activating a profile on the tablet mints a short-lived user-scoped token; ending the session revokes it. **A tablet with no active session can read nothing personal.**
- Session auto-expiry after inactivity, returning to a neutral household screen.
- Roles: `owner` (billing, member management, device reset) and `member`. All household members are 18+ (ruling E); there is no `minor` role in MVP. Owners can manage seats but **cannot read another member's nutrition data** — an explicit, stated product property.

## 3. Shared-device threats

| Threat | Control |
|---|---|
| Family member reads another's weight/logs | Session-scoped rendering; optional per-user PIN for detail views; neutral idle screen |
| Voice command logs to the wrong user | Every confirmation names the user; single-tap correction; short session timeout |
| Guest uses the device | Guest mode logs nothing personal |
| Device resold with data on it | Factory reset wipes local cache, revokes device keys, unbinds household; cloud data stays with users |
| Shoulder-surfing the dashboard | Configurable "hide numbers when idle" |

## 4. Voice privacy

- Wake-word processing entirely on-device; **no audio transmitted before detection**.
- Hardware mute switch that cuts mic power, plus an unambiguous recording indicator.
- Audio retention **off by default**; opt-in per user with consent recorded in `identity.consents` (timestamp, version, scope).
- Transcripts retained only in hashed form for eval sampling unless retention is opted into.
- No minor profiles exist in MVP (ruling E), so minor-specific retention rules do not apply; they return with the future dependent-profile track.

## 5. Transport, storage, secrets

- TLS 1.3 everywhere; certificate pinning on the tablet.
- BLE: LE Secure Connections, bonded pairing, per-household binding recorded server-side.
- At-rest encryption for database and object storage; PITR backups encrypted with separate keys.
- Device private keys provisioned at manufacture, stored in secure element where the hardware supports it (D-16).
- Signed firmware and app images; secure boot on the scale; staged rollout with automatic halt.
- Secrets in a managed store, never in the repo; per-environment isolation; short-lived credentials for CI.

## 6. Legal / regulatory posture

- **HIPAA**: likely out of scope (not a covered entity), but do not design in a way that forecloses a future covered relationship.
- **Consumer health data** (Washington MHMDA, Nevada SB370, CCPA/CPRA sensitive categories): treat weight, intake and inferred health data as regulated. Requires granular consent, a per-category deletion path, and a data-sale/share prohibition. Architecture implication: **per-user, per-category deletion inside a shared household must work without breaking other members' history** — this is why users are global identities and logs snapshot their nutrition.
- **Illinois BIPA**: if voice identification is ever built, voiceprints are biometric identifiers with written-consent, published-retention-schedule and private-right-of-action obligations. **Recommend not building voice ID in MVP** (D-09).
- **COPPA**: out of scope. Ruling E locks the initial commercial product to **18+ only** — no minor profiles exist in MVP-0 or MVP-1. Dependent/minor household profiles are a separate future safety and legal product track.
- **GDPR readiness**: even though MVP is US-only, build DSAR export, erasure and consent versioning now — retrofitting is far more expensive than including.
- **Not a medical device**: no diagnostic or therapeutic claims; disclaimers in onboarding; the assistant refuses medical advice and redirects to clinicians.

## 7. Vulnerable-user safety (a security control, not a UX nicety)

A device that reports deficit continuously will be used by people with disordered eating.

- **Hard floors** in the engine: target intake never below `max(1200 (F) / 1500 (M) kcal, 0.7 × BMR)`; extreme deficits require explicit confirmation. (Minor-specific rules are out of scope in MVP — 18+ only.)
- **Screening heuristics**: rapid target reduction, sustained large deficits, weight below a healthy BMI floor, ED-associated language → the assistant switches to a **scripted, non-generative** path that declines to optimize further and surfaces support resources. This path never goes through the LLM.
- **Refusal policy** for: medical advice, supplement/drug dosing, pregnancy-specific nutrition prescriptions, anything framed as treatment.
- Pregnancy and known medical conditions: acknowledge and defer to a clinician rather than adjusting targets.

## 8. AI-specific security

- Prompt injection via product names, ingredient lists and household-submitted foods: tool-returned content is delimited and labeled as data; the model's assertions never determine authorization; write tools require confirmation.
- Tool authorization is derived from the session, not the conversation (`07 §3`).
- Every tool call is logged with arguments and result hashes — a complete audit trail behind every number spoken aloud.
- Output validation (numeric fidelity) doubles as an injection tripwire.

## 9. Operational security

- Least-privilege service roles; no shared admin accounts; MFA required.
- Admin/data-steward console access is audited per action (a steward can see product data, never user nutrition data).
- Structured audit log for: seat changes, profile deletion, device reset, data export, steward merges.
- Incident runbooks for: suspected cross-user leak, catalog data corruption, model regression, firmware bricking.
- SOC 2 Type II as a Phase 9 target; design now so it is a documentation exercise, not a re-architecture.
