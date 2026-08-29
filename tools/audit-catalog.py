#!/usr/bin/env python3
"""
DATA-1 CATALOG HEALTH AUDIT.

Streams the real catalog and measures what a consumer product can actually
show. It MEASURES ONLY — no authoritative USDA value is altered, and a record
that looks odd is reported, never corrected. An implausible nutrient row is a
fact about the source data; silently fixing it would hide a coverage problem
behind a clean-looking number.

The branded catalog is ~312 MB against ~3 GB of RAM, so it is decoded
incrementally rather than loaded whole.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repo_paths import repo_path  # noqa: E402

# The AUTHORITATIVE current-version store: 257 NDJSON shards holding every
# published branded record. `branded-catalog.json` is an intermediate build
# artifact containing only ~98k products and would understate coverage by 77%.
AUTHORITY_DIR = repo_path("data", "offline-bundle", "authority")
PRODUCT_SHARD_DIR = repo_path("data", "branded")
GENERIC = repo_path("data", "usda-seed.json")
OUT_JSON = repo_path("data", "catalog-audit.json")

# Bounds for flagging IMPLAUSIBLE records. Nothing is rewritten; these only
# decide what appears in the "unsuitable for display" bucket.
MAX_KCAL_PER_100G = 900        # pure fat is ~900; above that is a data error
MAX_MACRO_G_PER_100G = 100     # a macro cannot exceed the mass containing it
ATWATER_TOLERANCE = 0.35       # 35% slack before calling kcal/macro disagreement


def stream_ndjson(directory, prefix):
    """Yield records from every NDJSON shard, one line at a time."""
    shards = sorted(Path(directory).glob(f"{prefix}*.ndjson"))
    if not shards:
        raise SystemExit(f"no {prefix}*.ndjson shards under {directory}")
    for shard in shards:
        with open(shard) as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)


def macro(per100g, key):
    node = (per100g or {}).get(key)
    if not isinstance(node, dict):
        return None
    amount = node.get("amount")
    return amount if isinstance(amount, (int, float)) else None


def audit_version(v, m):
    """Measure one branded version. Returns the display-quality verdict."""
    per = v.get("per100g") or {}
    kcal = macro(per, "energy_kcal")
    protein = macro(per, "protein")
    carbs = macro(per, "carbohydrate")
    fat = macro(per, "fat")

    if kcal is not None:
        m["with_kcal"] += 1
    if protein is not None and carbs is not None and fat is not None:
        m["with_full_macros"] += 1
    if v.get("brandName"):
        m["with_brand"] += 1
    if v.get("category"):
        m["with_category"] += 1
    if v.get("ingredientsText"):
        m["with_ingredients"] += 1

    grams = v.get("servingGrams")
    household = v.get("householdServingText")
    if isinstance(grams, (int, float)) and grams > 0:
        m["with_serving_grams"] += 1
        if household:
            m["with_serving_grams_and_text"] += 1
    elif household:
        m["with_serving_text_only"] += 1
    else:
        m["without_any_serving"] += 1

    # --- implausibility, reported not corrected ---------------------------
    problems = []
    if kcal is None:
        problems.append("no_energy")
    elif kcal < 0 or kcal > MAX_KCAL_PER_100G:
        problems.append("energy_out_of_range")
    for name, value in (("protein", protein), ("carbohydrate", carbs), ("fat", fat)):
        if value is None:
            continue
        if value < 0 or value > MAX_MACRO_G_PER_100G:
            problems.append(f"{name}_out_of_range")
    if None not in (kcal, protein, carbs, fat) and kcal and kcal > 0:
        atwater = protein * 4 + carbs * 4 + fat * 9
        if abs(atwater - kcal) > max(50.0, kcal * ATWATER_TOLERANCE):
            problems.append("energy_macro_disagreement")
    if not v.get("brandName"):
        problems.append("no_brand")

    for p in problems:
        m["problem_counts"][p] += 1
    return problems


def main():
    m = {
        "with_kcal": 0, "with_full_macros": 0, "with_brand": 0,
        "with_category": 0, "with_ingredients": 0,
        "with_serving_grams": 0, "with_serving_grams_and_text": 0,
        "with_serving_text_only": 0, "without_any_serving": 0,
        "problem_counts": Counter(),
    }

    current_versions = 0
    discontinued = 0
    displayable = 0
    problems_seen = Counter()
    brand_counts = Counter()
    name_brand_pairs = defaultdict(int)
    prep_states = Counter()

    # --- CURRENT branded versions (the display candidates) ----------------
    for v in stream_ndjson(AUTHORITY_DIR, "branded-"):
        current_versions += 1
        if v.get("discontinued"):
            discontinued += 1
        prep_states[v.get("preparationState") or "unknown"] += 1

        found = audit_version(v, m)
        # A missing brand does not make a record undisplayable; a missing or
        # impossible nutrient does.
        blocking = [p for p in found if p != "no_brand"]
        if not blocking:
            displayable += 1
        for p in found:
            problems_seen[p] += 1

        brand = (v.get("brandName") or "").strip().upper()
        name = (v.get("displayName") or "").strip().upper()
        if brand:
            brand_counts[brand] += 1
        if brand and name:
            name_brand_pairs[(name, brand)] += 1

        if current_versions % 100000 == 0:
            print(f"  ... {current_versions:,} current versions", file=sys.stderr)

    # --- product identity / lifecycle -------------------------------------
    products = 0
    identifier_states = Counter()
    identity_bases = Counter()
    version_ids_total = 0
    for p in stream_ndjson(PRODUCT_SHARD_DIR, "products-"):
        products += 1
        identifier_states[p.get("identifierState") or "unknown"] += 1
        identity_bases[p.get("identityBasis") or "unknown"] += 1
        version_ids_total += len(p.get("versionIds") or [])

    collisions = {k: c for k, c in name_brand_pairs.items() if c > 1}

    # --- generic catalog ---------------------------------------------------
    generic = json.loads(Path(GENERIC).read_text())
    items = generic if isinstance(generic, list) else generic.get("products", [])
    g = {"total": len(items), "with_kcal": 0, "with_full_macros": 0,
         "with_preparation": 0, "with_serving": 0, "recommendable": 0}
    g_prep = Counter()
    for item in items:
        # Generic foods carry the same `per100g` nutrient map as branded
        # records; they have no `basis` field. Reading the wrong key reported a
        # flat 0% and would have looked like a catastrophic coverage gap.
        per = item.get("per100g") or {}
        if macro(per, "energy_kcal") is not None:
            g["with_kcal"] += 1
        if all(macro(per, k) is not None
               for k in ("protein", "carbohydrate", "fat")):
            g["with_full_macros"] += 1
        prep = item.get("preparationState")
        if prep:
            g["with_preparation"] += 1
            g_prep[prep] += 1
        # A preparation RULE is what makes a generic food usable by weight.
        if item.get("preparationRule"):
            g["with_serving"] += 1
        if item.get("recommendable"):
            g["recommendable"] = g.get("recommendable", 0) + 1

    def pct(n, d):
        return round(100.0 * n / d, 2) if d else 0.0

    report = {
        "auditVersion": "catalog-audit@1.0.0",
        "generic": {**g, "preparationStates": dict(g_prep.most_common()),
                    "percentWithKcal": pct(g["with_kcal"], g["total"]),
                    "percentWithFullMacros": pct(g["with_full_macros"], g["total"])},
        "branded": {
            "products": products,
            "versionIdsTotal": version_ids_total,
            "currentVersions": current_versions,
            "historicalVersions": max(0, version_ids_total - products),
            "discontinuedCurrent": discontinued,
            "identifierStates": dict(identifier_states.most_common()),
            "identityBases": dict(identity_bases.most_common()),
            "withKcal": m["with_kcal"],
            "withFullMacros": m["with_full_macros"],
            "withBrand": m["with_brand"],
            "withIngredients": m["with_ingredients"],
            "withServingGrams": m["with_serving_grams"],
            "withServingGramsAndText": m["with_serving_grams_and_text"],
            "withServingTextOnly": m["with_serving_text_only"],
            "withoutAnyServing": m["without_any_serving"],
            "displayable": displayable,
            "percentWithKcal": pct(m["with_kcal"], current_versions),
            "percentWithFullMacros": pct(m["with_full_macros"], current_versions),
            "percentWithServingGrams": pct(m["with_serving_grams"], current_versions),
            "percentDisplayable": pct(displayable, current_versions),
            "problems": dict(problems_seen.most_common()),
            "distinctBrands": len(brand_counts),
            "topBrands": [[b, c] for b, c in brand_counts.most_common(15)],
            "collisionPairs": len(collisions),
            "collisionRecords": sum(collisions.values()),
            "preparationStates": dict(prep_states.most_common()),
        },
    }
    Path(OUT_JSON).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, indent=2, sort_keys=True))
    print(f"\nWrote {OUT_JSON}", file=sys.stderr)


if __name__ == "__main__":
    main()
