#!/usr/bin/env python3
"""
DATA-1 SEARCH-QUALITY BENCHMARK.

A golden corpus of queries a real person would type or say, scored against the
CURRENT search behaviour. It measures; it never tunes. Changing deterministic
food identity to make a score look better would trade a real property for a
number.

Relevance is judged by required/forbidden token rules per query rather than by a
single expected product id, because several catalog records can be a correct
answer to "banana" and pinning one would make the benchmark brittle.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repo_paths import repo_path  # noqa: E402

GENERIC = repo_path("data", "usda-seed.json")
AUTHORITY = repo_path("data", "offline-bundle", "authority")
OUT = repo_path("data", "search-benchmark.json")

# (query, category, required tokens (all), forbidden tokens (none), notes)
CORPUS = [
    # --- common foods -------------------------------------------------
    ("banana", "common", ["banana"], [], ""),
    ("eggs", "common", ["egg"], [], "plural of a staple"),
    ("whole milk", "common", ["milk"], [], ""),
    ("peanut butter", "common", ["peanut"], [], ""),
    ("white rice", "common", ["rice"], [], ""),
    ("cheddar cheese", "common", ["cheddar"], [], ""),
    ("olive oil", "common", ["olive"], [], ""),
    ("almonds", "common", ["almond"], [], ""),
    # --- raw vs cooked: the highest-consequence distinction -----------
    ("chicken breast", "preparation", ["chicken"], [], "ambiguous by design"),
    ("cooked chicken breast", "preparation", ["chicken"], [], "must favour cooked"),
    ("raw chicken breast", "preparation", ["chicken"], [], "must favour raw"),
    ("white rice cooked", "preparation", ["rice"], [], ""),
    ("boiled egg", "preparation", ["egg"], [], ""),
    # --- branded -------------------------------------------------------
    ("greek yogurt", "branded", ["yogurt"], [], ""),
    ("quaker oats", "branded", ["oat"], [], ""),
    ("coca cola", "branded", ["cola"], [], ""),
    ("cheerios", "branded", ["cheerio"], [], ""),
    # --- plural / singular --------------------------------------------
    ("egg", "morphology", ["egg"], [], ""),
    ("bananas", "morphology", ["banana"], [], ""),
    ("almond", "morphology", ["almond"], [], ""),
    # --- spelling ------------------------------------------------------
    ("chiken breast", "spelling", ["chicken"], [], "common typo"),
    ("brocoli", "spelling", ["broccoli"], [], "common typo"),
    ("yoghurt", "spelling", ["yog"], [], "British spelling"),
    # --- abbreviations --------------------------------------------------
    ("pb", "abbreviation", ["peanut"], [], "peanut butter"),
    ("og chicken", "abbreviation", ["chicken"], [], ""),
    # --- natural language ------------------------------------------------
    ("a cup of white rice", "natural_language", ["rice"], [], ""),
    ("two scrambled eggs", "natural_language", ["egg"], [], ""),
    ("some grilled chicken", "natural_language", ["chicken"], [], ""),
    # --- cuisine terms ----------------------------------------------------
    ("hummus", "cuisine", ["hummus"], [], ""),
    ("tofu", "cuisine", ["tofu"], [], ""),
    ("basmati rice", "cuisine", ["rice"], [], ""),
    ("salsa", "cuisine", ["salsa"], [], ""),
]

STOPWORDS = {"a", "an", "the", "of", "some", "two", "cup", "cups"}


def tokenize(text):
    return [t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if t]


def load_index():
    """Name + brand for every searchable record, generic first."""
    docs = []
    for item in json.loads(Path(GENERIC).read_text()):
        docs.append({
            "id": item.get("productId"),
            "name": item.get("displayName") or "",
            "brand": None,
            "prep": item.get("preparationState") or "as_sold",
            "kind": "generic",
            "aliases": item.get("aliases") or [],
        })
    for shard in sorted(Path(AUTHORITY).glob("branded-*.ndjson")):
        with open(shard) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                v = json.loads(line)
                docs.append({
                    "id": v.get("productId"),
                    "name": v.get("displayName") or "",
                    "brand": v.get("brandName"),
                    "prep": v.get("preparationState") or "as_sold",
                    "kind": "branded",
                    "aliases": [],
                })
    return docs


def score(doc, query_tokens):
    """
    Deterministic lexical score. Mirrors the shape of the runtime ranker:
    exact-ish name matches beat partial ones, and generic foods outrank branded
    for bare queries because "banana" should not return a branded smoothie.
    """
    name_tokens = tokenize(doc["name"]) + tokenize(doc["brand"]) + [
        t for a in doc["aliases"] for t in tokenize(a)
    ]
    if not name_tokens:
        return 0.0
    name_set = set(name_tokens)
    hits = sum(1 for t in query_tokens if t in name_set)
    if hits == 0:
        return 0.0
    coverage = hits / len(query_tokens)
    # Prefer concise names: "BANANA" over "BANANA NUT CRUNCH GRANOLA CLUSTERS".
    brevity = 1.0 / (1.0 + max(0, len(name_tokens) - len(query_tokens)) * 0.08)
    kind_bonus = 1.12 if doc["kind"] == "generic" else 1.0
    return coverage * brevity * kind_bonus


def relevant(doc, required, forbidden):
    haystack = f"{doc['name']} {doc['brand'] or ''}".lower()
    if any(f in haystack for f in forbidden):
        return False
    return all(r in haystack for r in required)


def main():
    print("loading catalog …", file=sys.stderr)
    docs = load_index()
    print(f"  {len(docs):,} searchable records", file=sys.stderr)

    results = []
    for query, category, required, forbidden, note in CORPUS:
        q = [t for t in tokenize(query) if t not in STOPWORDS]
        scored = []
        for d in docs:
            s = score(d, q)
            if s > 0:
                scored.append((s, d))
        scored.sort(key=lambda x: (-x[0], x[1]["name"]))
        top = [d for _, d in scored[:3]]

        results.append({
            "query": query,
            "category": category,
            "note": note,
            "resultCount": len(scored),
            "noResult": len(scored) == 0,
            "top1Relevant": bool(top) and relevant(top[0], required, forbidden),
            "top3Relevant": any(relevant(d, required, forbidden) for d in top),
            "top3": [{"name": d["name"], "brand": d["brand"], "prep": d["prep"],
                      "kind": d["kind"]} for d in top],
        })

    total = len(results)
    def rate(key):
        return round(100.0 * sum(1 for r in results if r[key]) / total, 1)

    by_category = {}
    for r in results:
        c = by_category.setdefault(r["category"], {"n": 0, "top1": 0, "top3": 0, "none": 0})
        c["n"] += 1
        c["top1"] += 1 if r["top1Relevant"] else 0
        c["top3"] += 1 if r["top3Relevant"] else 0
        c["none"] += 1 if r["noResult"] else 0

    summary = {
        "benchmarkVersion": "search-quality@1.0.0",
        "corpusSize": total,
        "searchableRecords": len(docs),
        "top1RelevancePercent": rate("top1Relevant"),
        "top3RelevancePercent": rate("top3Relevant"),
        "noResultPercent": rate("noResult"),
        "byCategory": by_category,
        "queries": results,
    }
    Path(OUT).write_text(json.dumps(summary, indent=2) + "\n")

    print(f"\ntop-1 relevance : {summary['top1RelevancePercent']}%")
    print(f"top-3 relevance : {summary['top3RelevancePercent']}%")
    print(f"no-result rate  : {summary['noResultPercent']}%")
    print("\nby category:")
    for c, v in sorted(by_category.items()):
        print(f"  {c:18} n={v['n']:2}  top1={v['top1']:2}  top3={v['top3']:2}  none={v['none']}")
    print("\nfailures:")
    for r in results:
        if not r["top3Relevant"]:
            got = r["top3"][0]["name"] if r["top3"] else "(nothing)"
            print(f"  {r['query']:26} -> {got[:52]}")
    print(f"\nWrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
