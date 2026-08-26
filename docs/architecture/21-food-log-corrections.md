# 21 — Food Log Corrections

> **CORRECTION DOMAIN — ENGINEERING CLOSED.**
> **RUNTIME DB VALIDATION — PENDING (migration 0004 never executed).**

## 1. The rule

> **A stored food log is never mutated — not its nutrition, not its weight, not
> even its status.**

It is the historical record of what the user was told they ate. A correction is
a **new entry** naming the entry it supersedes; a void is a **new entry** naming
the entry it removes. Effective state is **derived by folding the stream**.

This is not a stylistic preference. The persisted schema grants `INSERT` only —
there is no `UPDATE` policy and no `UPDATE` grant — so a stored row physically
cannot be rewritten. Any correction design that required mutation would have
been unimplementable against the locked schema.

## 2. Why status is derived, not stored

`FoodLogStatus` has always had `superseded` and `voided`, but nothing produced
them. Making them writable would mean updating a stored row. Instead, `status`
records what an entry was **at write time** and stays `'active'` forever; the
fold decides what is currently effective. A disputed number is therefore still
auditable months later, exactly as first written.

## 3. The fold

`foldFoodLogEntries(userId, entries)` → `{ effective, superseded, voided,
conflicts, foldVersion }`.

PURE: no clock, no repository, no id generation, no arithmetic. It **selects**
entries; every number it surfaces was computed by the nutrition engine before
folding.

**Deterministic.** Ordering is established by recorded time then `logId` —
never by array position — so any delivery order yields the same result.

## 4. Conflicts are reported, never guessed

| Situation | Outcome |
|---|---|
| Two corrections of one entry | first in deterministic order applies; the second is **reported** |
| Correction of an unknown entry | reported; the real entry untouched |
| Correction of an already-voided entry | reported; the meal is **not** revived |
| Double void | reported; one removal |
| Void of an unknown entry | reported |
| Self-supersession | `correction_cycle`; no infinite loop |
| Duplicate original id | reported |
| Entry belonging to another user | `cross_user_entry`; never folded in |

Nothing is silently applied and nothing is silently dropped. A conflicted
correction surfaces so a human decides.

## 5. Local day safety

A correction **inherits** the original's local date, timezone and UTC offset. A
correction claiming a different local day is refused with
`correction_changes_local_day`. Moving a meal to another day is a different
operation and is never done implicitly — otherwise a correction could silently
alter two days' totals at once.

## 6. Voids carry no nutrition

A `FoodLogVoidEntry` has no snapshot and no grams. A voided meal did not happen,
and writing zeroed nutrition for it would place a fabricated record in the log
stream. Voids live in their own table because `food_logs` requires nutrition on
every row — a requirement worth keeping.

Voiding a corrected meal removes the **whole chain**: the user voids the meal by
the id they remember, and V1 is not resurrected.

## 7. Daily totals

`aggregateDailyIntake` folds first, then sums the **stored snapshots** of the
effective set. A corrected entry contributes once, at its corrected value; a
voided entry contributes nothing; superseded entries are retained in storage and
never counted twice.

## 8. Persistence (migration 0004, additive)

`food_logs` gains `entry_kind`, `supersedes_log_id`, `correction_reason` with:

- a shape constraint — a correction must name a target, an original must not;
- `supersedes_log_id <> log_id`;
- a **composite** FK `(user_id, supersedes_log_id)` so a correction can never
  reach across users;
- a partial unique index — at most one correction per target, because two
  corrections of one entry is a conflict a human resolves, not a race the
  database settles by last-writer-wins.

`food_log_voids` is a new append-only table with the same composite same-user
reference, one void per target, RLS enabled and forced, `SELECT`/`INSERT` only.

## 9. The lineage round-trip

**A defect worth recording.** The first implementation stored corrections
without lineage columns, so a correction read back from storage looked like a
second original and the day was **double-counted**. The regression test decodes
rows through the real codec rather than trusting in-memory objects.
