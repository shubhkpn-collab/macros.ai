#!/usr/bin/env python3
"""
SEARCH-1 SEARCH-QUALITY BENCHMARK.

Measures the resilient query pipeline against a 255-query golden corpus.

The headline metric is NOT top-1 relevance. It is the UNSAFE WRONG RESULT rate:
how often the search returns a confident answer that is materially the wrong
food. `chiken breast` returning TURKEY BREAST with full confidence is far worse
than returning nothing, because the person has no signal to doubt it.

Nothing here tunes the search. Expected identities are never edited to lift a
score; a failure stays a failure.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repo_paths import repo_path  # noqa: E402
from search_corpus import corpus  # noqa: E402

GENERIC = repo_path("data", "usda-seed.json")
AUTHORITY = repo_path("data", "offline-bundle", "authority")
OUT = repo_path("data", "search-benchmark.json")

FILLER = {"a", "an", "the", "of", "some", "my", "i", "ate", "had", "with",
          "and", "please", "add", "log", "me", "for", "to", "is", "it"}
QUANTITY = {"one", "two", "three", "four", "half", "cup", "cups", "scoop",
            "scoops", "slice", "slices", "piece", "pieces", "serving",
            "servings", "bowl", "plate", "glass", "tbsp", "tsp", "gram",
            "grams", "g", "oz", "ounce", "ounces", "100"}
PREPARATION = {"raw", "cooked", "boiled", "baked", "grilled", "roasted",
               "fried", "steamed", "poached", "scrambled", "dried", "frozen",
               "canned", "uncooked", "prepared", "toasted", "smoked"}
ABBREVIATIONS = {
    "pb": "peanut butter", "og": "organic", "bbq": "barbecue",
    "veg": "vegetable", "choc": "chocolate", "yog": "yogurt",
    "gf": "gluten free", "ww": "whole wheat", "evoo": "olive oil",
    "cx": "chicken",
}


def tokenize(text):
    return [t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if t]


def singularize(t):
    if len(t) <= 3:
        return t
    if t.endswith("ies") and len(t) > 4:
        return t[:-3] + "y"
    if t.endswith(("ses", "xes", "zes", "ches", "shes")):
        return t[:-2]
    if t.endswith("s") and not t.endswith("ss") and not t.endswith("us"):
        return t[:-1]
    return t


def allowed_distance(t):
    if len(t) <= 4:
        return 0
    if len(t) <= 7:
        return 1
    return 2


def bounded_distance(a, b, max_d):
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_d:
        return max_d + 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        best = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
            cur.append(v)
            best = min(best, v)
        if best > max_d:
            return max_d + 1
        prev = cur
    return prev[len(b)]


def load_index():
    docs = []
    for item in json.loads(Path(GENERIC).read_text()):
        docs.append({
            "name": item.get("displayName") or "", "brand": None,
            "prep": item.get("preparationState") or "as_sold", "kind": "generic",
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
                    "name": v.get("displayName") or "", "brand": v.get("brandName"),
                    "prep": v.get("preparationState") or "as_sold",
                    "kind": "branded", "aliases": [],
                })
    vocab = set()
    brands = set()
    freq = {}
    for d in docs:
        d["tokens"] = set(tokenize(d["name"])) | set(tokenize(d["brand"])) | {
            t for a in d["aliases"] for t in tokenize(a)}
        vocab |= d["tokens"]
        for t in d["tokens"]:
            freq[t] = freq.get(t, 0) + 1
        if d["brand"]:
            brands |= set(tokenize(d["brand"]))
    return docs, vocab, brands, freq


RARE_TERM_THRESHOLD = 3
DOMINANCE_RATIO = 50


def dominant_neighbour(term, vocab, freq, term_freq):
    """A decisively more common word one edit away, or None."""
    best, best_freq = None, term_freq * DOMINANCE_RATIO
    for c in vocab:
        if c == term or abs(len(c) - len(term)) > 1:
            continue
        if bounded_distance(term, c, 1) > 1:
            continue
        f = freq.get(c, 0)
        if f > best_freq:
            best, best_freq = c, f
    return best


def resolve(query, vocab, freq):
    """Mirrors packages/domain-food-search/src/resilient-query.ts."""
    expanded = []
    used_abbrev = False
    for t in tokenize(query):
        if t in ABBREVIATIONS:
            used_abbrev = True
            expanded.extend(tokenize(ABBREVIATIONS[t]))
        else:
            expanded.append(t)

    terms, preps, unresolved, corrections = [], [], [], []
    for t in expanded:
        if t in FILLER or t in QUANTITY:
            continue
        if t in PREPARATION:
            preps.append(t)
            terms.append(t)
            continue
        sing = singularize(t)
        exact = t if t in vocab else (sing if sing in vocab else None)
        if exact is not None:
            # The catalog contains its own misspellings, so an exact match on a
            # vanishingly rare term is not understanding — it is matching noise.
            ef = freq.get(exact, 10**9)
            if ef <= RARE_TERM_THRESHOLD:
                dom = dominant_neighbour(exact, vocab, freq, ef)
                if dom is not None:
                    terms.append(dom)
                    corrections.append((t, dom))
                    continue
            terms.append(exact)
            continue
        max_d = allowed_distance(sing)
        best, best_d, tied = None, max_d + 1, False
        if max_d > 0:
            for c in vocab:
                if abs(len(c) - len(sing)) > max_d:
                    continue
                d = bounded_distance(sing, c, max_d)
                if d > max_d:
                    continue
                if d < best_d:
                    best_d, best, tied = d, c, False
                elif d == best_d and c != best:
                    cf, bf = freq.get(c, 1), freq.get(best, 1) if best else 0
                    if cf > bf * DOMINANCE_RATIO:
                        best, tied = c, False
                    elif bf > cf * DOMINANCE_RATIO:
                        pass
                    else:
                        tied = True
        if best is not None and not tied:
            terms.append(best)
            corrections.append((t, best))
        else:
            unresolved.append(t)

    if not terms:
        conf = "unresolved"
    elif unresolved:
        conf = "unresolved"
    elif corrections or used_abbrev:
        conf = "did_you_mean"
    else:
        conf = "confident"
    return {"terms": terms, "preps": preps, "unresolved": unresolved,
            "corrections": corrections, "confidence": conf}


def score(doc, terms, preps):
    if not terms:
        return 0.0
    hits = sum(1 for t in terms if t in doc["tokens"])
    if hits == 0:
        return 0.0
    coverage = hits / len(terms)
    # Preparation is SEMANTIC: a query saying "cooked" should not win with a raw
    # food, and vice versa.
    prep_bonus = 1.0
    for p in preps:
        if p in ("cooked", "boiled", "baked", "grilled", "roasted", "fried",
                 "steamed", "poached"):
            prep_bonus *= 1.25 if doc["prep"] == "cooked" else 0.85
        elif p in ("raw", "uncooked"):
            prep_bonus *= 1.25 if doc["prep"] == "raw" else 0.85
    brevity = 1.0 / (1.0 + max(0, len(doc["tokens"]) - len(terms)) * 0.08)
    kind_bonus = 1.12 if doc["kind"] == "generic" else 1.0
    return coverage * brevity * kind_bonus * prep_bonus


def relevant(doc, required_any, forbidden):
    hay = f"{doc['name']} {doc['brand'] or ''}".lower()
    if any(f in hay for f in forbidden):
        return False
    return all(any(alt in hay for alt in group.split("|")) if "|" in group
               else group in hay for group in required_any)


def unsafe(doc, forbidden):
    """A forbidden token present means a materially DIFFERENT food."""
    hay = f"{doc['name']} {doc['brand'] or ''}".lower()
    return any(f in hay for f in forbidden)


def main():
    print("loading catalog ...", file=sys.stderr)
    docs, vocab, _brands, freq = load_index()
    print(f"  {len(docs):,} records, {len(vocab):,} vocabulary terms", file=sys.stderr)

    queries = corpus()
    results = []
    for i, q in enumerate(queries):
        r = resolve(q["query"], vocab, freq)
        scored = []
        for d in docs:
            s = score(d, r["terms"], r["preps"])
            if s > 0:
                scored.append((s, d))
        scored.sort(key=lambda x: (-x[0], x[1]["name"]))
        top = [d for _, d in scored[:3]]
        top_score = scored[0][0] if scored else 0.0
        runner = scored[1][0] if len(scored) > 1 else 0.0

        confidence = r["confidence"]
        if not scored:
            confidence = "unresolved"
        elif confidence == "confident" and top_score > 0 and runner / top_score > 0.92:
            confidence = "ambiguous"

        expectation = q["expectation"]
        top1_rel = bool(top) and relevant(top[0], q["requiredAny"], q["forbidden"])
        top3_rel = any(relevant(d, q["requiredAny"], q["forbidden"]) for d in top)

        # UNSAFE: a CONFIDENT answer that is materially the wrong food.
        is_unsafe = (
            confidence == "confident" and bool(top)
            and (unsafe(top[0], q["forbidden"])
                 or (expectation == "absent"))
        )

        results.append({
            "query": q["query"], "category": q["category"],
            "expectation": expectation, "confidence": confidence,
            "resultCount": len(scored),
            "noResult": len(scored) == 0,
            "top1Relevant": top1_rel, "top3Relevant": top3_rel,
            "unsafeWrong": is_unsafe,
            "corrections": r["corrections"],
            "top3": [{"name": d["name"], "brand": d["brand"], "prep": d["prep"]}
                     for d in top],
        })
        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(queries)}", file=sys.stderr)

    n = len(results)
    resolvable = [r for r in results if r["expectation"] != "absent"]

    def pct(count, denom):
        return round(100.0 * count / denom, 1) if denom else 0.0

    by_cat = {}
    for r in results:
        c = by_cat.setdefault(r["category"], {"n": 0, "top1": 0, "top3": 0,
                                              "none": 0, "unsafe": 0})
        c["n"] += 1
        c["top1"] += 1 if r["top1Relevant"] else 0
        c["top3"] += 1 if r["top3Relevant"] else 0
        c["none"] += 1 if r["noResult"] else 0
        c["unsafe"] += 1 if r["unsafeWrong"] else 0

    summary = {
        "benchmarkVersion": "search-quality@2.0.0",
        "corpusSize": n,
        "searchableRecords": len(docs),
        "vocabularyTerms": len(vocab),
        "top1RelevancePercent": pct(sum(1 for r in resolvable if r["top1Relevant"]), len(resolvable)),
        "top3RelevancePercent": pct(sum(1 for r in resolvable if r["top3Relevant"]), len(resolvable)),
        "noResultPercent": pct(sum(1 for r in results if r["noResult"]), n),
        "unsafeWrongResultPercent": pct(sum(1 for r in results if r["unsafeWrong"]), n),
        "ambiguityPercent": pct(sum(1 for r in results if r["confidence"] == "ambiguous"), n),
        "didYouMeanPercent": pct(sum(1 for r in results if r["confidence"] == "did_you_mean"), n),
        "confidencePercent": pct(sum(1 for r in results if r["confidence"] == "confident"), n),
        "byCategory": by_cat,
        "queries": results,
    }
    Path(OUT).write_text(json.dumps(summary, indent=2) + "\n")

    print(f"\ncorpus            : {n} queries ({len(resolvable)} resolvable)")
    print(f"top-1 relevance   : {summary['top1RelevancePercent']}%")
    print(f"top-3 relevance   : {summary['top3RelevancePercent']}%")
    print(f"no-result         : {summary['noResultPercent']}%")
    print(f"UNSAFE WRONG      : {summary['unsafeWrongResultPercent']}%")
    print(f"ambiguous         : {summary['ambiguityPercent']}%")
    print(f"did-you-mean      : {summary['didYouMeanPercent']}%")
    print("\nby category:")
    for c, v in sorted(by_cat.items()):
        print(f"  {c:18} n={v['n']:3} top1={v['top1']:3} top3={v['top3']:3} "
              f"none={v['none']:2} unsafe={v['unsafe']}")
    unsafe_list = [r for r in results if r["unsafeWrong"]]
    if unsafe_list:
        print("\nUNSAFE RESULTS:")
        for r in unsafe_list:
            print(f"  {r['query']:24} -> {r['top3'][0]['name'][:50] if r['top3'] else '(none)'}")
    print(f"\nWrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
