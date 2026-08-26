# 25 — Extensible Nutrient Tracking and Customizable View

> **EXTENSIBLE NUTRIENT TRACKING + CUSTOMIZABLE VIEW — ENGINEERING CLOSED.**

MACROS.AI is not a four-number tracker. Any nutrient an authoritative source
reports can be preserved, canonicalized and tracked; what the user *sees* is a
separate decision from what the system *knows*.

## 1. Canonical identity

Stable internal ids (`vitamin_d`, `total_sugars`, `pantothenic_acid`) — never
display strings, never a source's ids. **A USDA nutrient id is provenance, not
identity**: if USDA renumbered tomorrow, stored history would still mean the
same thing.

## 2. Unit authority

One canonical unit per nutrient. Conversions are permitted only within the
metric mass ladder (g ↔ mg ↔ µg) and are exact and reversible.

**IU is deliberately non-convertible.** The IU→µg factor differs per substance
(retinol vs beta-carotene, D2 vs D3), so a generic conversion would fabricate
values. USDA's IU rows for Vitamins A and D are excluded in favour of the µg
rows. kcal never converts to a mass.

## 3. Missing is never zero

A food with no recorded Vitamin D does not contain zero Vitamin D. Absence is
**structural**: `nutrientValue()` returns `null`, never `0`, and a nutrient no
food reported simply does not appear in the day's totals.

## 4. Coverage travels with every total

Summing what was reported and presenting it as the day's truth would turn
"four of five foods reported fiber" into a confident wrong number. Every daily
total carries `itemsWithData / itemsTotal` and a `complete` flag, so the product
can say *18 g known, partial data* instead of *18 g*.

## 5. Source facts preserved

Each canonical amount retains the source nutrient id, name, unit, original
amount and any conversion applied (`mg->g`). A mapping later found wrong is
auditable rather than invisible.

## 6. Core vs extended

Core stays the energy/macro four; energy and recommendation engines keep
consuming the narrow state they need. Extended nutrients live in a **map**, not
dozens of columns, so five nutrients or a hundred are equally normal.

**Fiber** is a first-class default-visible nutrient but adds **no** independent
energy — the source kcal already accounts for the food's declared energy, so
counting it again would double-count.

## 7. Version identity

Extended nutrients participate in `ProductVersion` factual identity: a corrected
sodium, fiber, Vitamin D or calcium value produces V2 even when the four macros
are unchanged. Serialization is sorted by nutrient id, so key order cannot alter
a fingerprint. Provenance-location changes remain non-versioning.

## 8. Historical snapshots

`NutritionSnapshot` freezes extended nutrients **at log time**. If a source later
adds a Vitamin C value the product never previously reported, yesterday's log
keeps exactly what the user was told they ate.

## 9. User view preferences

Default visible: **protein, carbohydrate, fat, fiber** — energy and current
balance remain the separate primary KPI above them. Users may add sodium,
Vitamin D, B12 and so on, bounded to 12 for a readable dashboard.

**Hiding a nutrient changes the dashboard only.** MACROS.AI keeps preserving
every trustworthy value, so enabling sodium next month yields real history, not
a gap. Only known canonical ids are selectable; selections are deduplicated; a
preference belongs to exactly one subject and cannot resolve for another.

## 10. Targets are a separate concern

No default micronutrient targets exist. With no target, an **amount is shown and
no percentage is manufactured** — a percentage against an invented target would
be a medical claim in disguise. Reviewed target policies can be supplied later.

**No deficiency claims.** "You averaged 18 g of fiber over 7 days" is arithmetic;
"your fiber is too low" or "you are Vitamin D deficient" is not, and neither is
supported.

## 11. Assistant queries

**One** extensible `ask_nutrient` intent carrying a canonical nutrient id — not
a new intent per nutrient. The model may name *which* nutrient; the trusted
nutrient state supplies the amount, and a model-supplied amount is rejected like
any other nutrition field. Where coverage is partial, the spoken answer says so.
The deterministic parser handles these offline.

## 12. Recommendations unchanged

Ranking remains goal-aware around remaining intake, protein, carbs and fat.
Micronutrients are **informational only** — there are no hidden vitamin weights.
Micronutrient-aware recommendation is recorded as a future reviewed policy.
