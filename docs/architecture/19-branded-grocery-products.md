# 19 — Branded Grocery Products

> **BRANDED GROCERY PRODUCT DOMAIN — ENGINEERING CLOSED.**
> **REAL BRANDED CATALOG POPULATION — PENDING APPROVED SOURCE DATA.**
>
> **0 unauthorized real branded products were ingested.** No retailer or
> manufacturer was scraped, no real brand nutrition was copied, no real UPC or
> GTIN was used. Every fixture is fictional and tagged `synthetic_test` on all
> three axes: source kind, verification status and licence class.

## 1. Branded is not a second nutrition system

Generic and branded foods both resolve to `ProductVersion`, and both use
`NutrientBasis`, `calculateNutrition()` and `FoodLogItem`. Branded products add
**identification, label and package metadata** — nothing more. There is one
nutrition engine.

## 2. Licence permission vs nutrition evidence

Two axes, permanently separate:

```
publicationScope   production_allowed | test_only | blocked
nutritionEvidence  manufacturer_label | authoritative_database |
                   curated_database | estimated | synthetic_test
```

"We may legally publish this" is not "these numbers are verified". A source
passing `isPublishable()` never becomes `auto_validated` nutrition, and **USDA
data is never presented as manufacturer-verified** merely because USDA is
authoritative. `trustLabelFor()` maps evidence to `manufacturer` / `database` /
`estimated` / `synthetic` at the data level; final visual copy is not locked.

## 3. Source binding

Provenance is never inferred from `dataType` alone. `canonicalSourceKind()`
requires a validated provider **and** dataType together; an unknown combination
throws rather than falling back to a misleading kind. Before publication the
importer proves adapter, source definition and every raw record agree on source
key, provider, data type, release and file hash — a record belonging to another
source is rejected, never normalized under the caller's provenance.

## 4. External identifiers

```
GTIN → catalog head → current ProductVersion
```

A barcode is **external identity**, never the MACROS.AI `productId` and never a
version id. A manufacturer can reformulate without changing the barcode, and
reassign a barcode without changing the food; our identity survives both.
Historical logs keep pointing at the exact version they were created with — they
never follow the head.

Supported: GTIN-12, GTIN-13, GTIN-14, plus source-specific schemes. Values are
normalized to 14 digits so a UPC-A and its EAN-13 form resolve as one product.

**Check digits are validated.** An arbitrary numeric string is not a GTIN;
accepting one would let a typo resolve to a real product.

## 5. Lookup outcomes

`exact_match` · `not_found` · `ambiguous` · `invalid_identifier`.

An unknown barcode is `not_found` — **no generic fallback, no estimate, no LLM
guess**. Two active products claiming one GTIN is `ambiguous`; neither wins,
because silently choosing one logs the wrong food. A partial unique index
(`WHERE state = 'current'`) makes the conflict impossible to represent in the
database as well.

## 6. Package label facts

The declared label is retained verbatim: serving description, serving grams or
millilitres, servings per container, net quantity, and per-serving nutrients.
Every field is optional **only** because a source may omit it — a missing label
fact stays missing.

## 7. The label is never reconstructed

```
per100g = perServing / servingGrams × 100
```

Label values are rounded under labelling rules, so multiplying per-100 g values
back does **not** reproduce the printed label. Both are stored; when they
disagree, **the original label wins as the record of what the source stated**. A
test proves the reconstruction differs and that the stored label is untouched.

**A serving with no defensible gram basis is not converted.** "1 cup" with no
gram equivalent goes to curation; inventing a generic density would produce
confident wrong nutrition.

## 8. Brand, manufacturer, variant

Kept structured — brand, manufacturer, product name and variant are separate
fields, because concatenating them destroys the query signal. A different brand
or a different variant is a **different product**, not a relabel.

## 9. Version identity (the A7 classification)

**Immutable food facts** — part of version identity: display name, preparation
state, per-100 g basis, brand, variant, declared serving basis.

**Mutable metadata** — deliberately excluded: category, aliases, verification
status, last-verified date, release id and file hash, **package descriptor**,
**external identifiers**, image reference.

Package size and GTIN are excluded on purpose. Both change for commercial
reasons unrelated to what a gram of the food contains; including them would
manufacture versions and silently split a product's history for a carton
redesign.

## 10. Reformulation

Same product, same GTIN, new nutrition → **V2**, head advances, V1 retained.
The barcode now resolves to V2; a log written against V1 keeps V1's nutrition
forever. This is precisely why `barcode ≠ productVersionId`.

An unexpected identifier change with otherwise similar facts is **not** silently
applied — it goes to curation.

## 11. Source conflicts

```
manufacturer label > approved retailer > authoritative database >
curated database > estimate
```

Equal priority with disagreeing facts is `needs_curation`. **Values are never
averaged** — an average is a number no source stands behind.

## 12. Product cards

A card answers "which exact product is this?" It carries only source-backed
facts, and absent facts stay absent — it never invents a serving size, package
descriptor, brand or barcode to fill a layout, and a product without an image is
still selectable.

**The card is not the log.** A card may read "150 kcal per 40 g serving" while
the scale reads 83 g; the log preview always comes from
`calculateNutrition(ProductVersion, capturedGrams)`.

Text search and barcode lookup converge on the **same canonical version and the
same card**. There is no barcode-specific nutrition model.

## 13. Search

Generic and branded coexist without collapsing. Branded products do not
automatically outrank generic foods; ranking answers "which exact food did the
user mean?" Brand tokens, product name, variant and aliases all match. Recent
history nudges a user's own products and **never crosses users** — proven
against a no-history baseline, since the natural tie-break order would otherwise
mask a leak.

## 14. Synthetic fixtures

Ten fictional branded products across oats, Greek yogurt, bread, milk, protein
drink, frozen food, snack and sauce — with valid computed GTINs, variants, same
brand/different product, a reformulated V2, a duplicate-identifier conflict case,
package descriptors and serving masses. A test asserts none carries a real brand
name.

## 15. Persistence

Migration `0003` adds `product_external_identifiers`, `catalog_product_aliases`
and `catalog_review_metadata`. Additive only; RLS enabled and forced; catalog is
read-only for end users with no mutation policies or grants; no cascading
deletes. **Authored and statically tested — runtime validation pending.**
