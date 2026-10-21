# Nutrition knowledge in continuous voice

The continuous audio session now exposes `retrieve_nutrition_knowledge`. It retrieves up to three versioned, source-linked passages from a curated local corpus of 40 passages: six existing product-rule explanations and 34 public-source summaries. Coverage includes the energy budget, macro policy, activity quality, portions, confirmation, next-food workflow, labels, hydration, sports-protein questions, and food safety.

This is a small lexical retrieval implementation, not an embeddings service, a comprehensive clinical nutrition library, or a complete ingestion of historical chats. Its corpus contains authored implementation summaries and source-linked public guidance, not clinician-approved advice. Public passages carry PUBLIC_SOURCE_SUMMARY, a publisher and a verification date. Macro policy passages explicitly retain `PENDING_EXTERNAL_REVIEW`; implementation availability does not imply clinical approval.

The voice instructions require retrieval for explanatory nutrition questions. Retrieved material is data, not instructions. Personal values and food-specific nutrients still come from the existing state, catalog and deterministic calculation tools. Retrieval cannot log food or replace independent spoken confirmation. Unsupported questions return no passages instead of fabricated citations.

Topic redirection currently uses conversation instructions. This is not a guaranteed domain firewall: direct audio may generate a response before a separate transcript-based gate could inspect it. A strict nutrition-only release needs measured voice evaluations and a response-control design before claiming enforcement. The architecture's planned pre-model gate, numeric speech validator and vector retrieval service remain separate work.

The current preview still uses synthetic nutrition/activity fixtures. Actual phone audio, grounded conversational behavior, interruption timing and off-topic resilience must be tested on-device. No new live paid API call was needed for the automated implementation checks.


## Expanded source manifest — verified October 14, 2026

| Source | Passages | Coverage |
|---|---:|---|
| [FDA label guide](https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label) | 6 | serving size, calories, sugar, Daily Value, comparisons, package columns |
| [FoodSafety.gov kitchen practices](https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety) | 5 | washing, separation, refrigeration, thawing |
| [FoodSafety.gov temperature chart](https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures) | 4 | poultry, ground meat, whole cuts, reheating |
| [FoodSafety.gov storage chart](https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts) | 2 | cooked leftovers, eggs, soups |
| [NIH exercise supplement guide](https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-Consumer/) | 4 | protein, plant variety, powders, BCAAs |
| [CDC water guide](https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html) | 3 | variable needs, drink swaps, habits |

These are short authored summaries, not full-page copies. The checked-in corpus is bundled with the Android app, requires no embedding service, and does not browse during a conversation. Relevance ranking weights distinctive query terms and passage titles, returning at most three passages. Thirty-two knowledge tests currently exercise retrieval, unsupported queries, provenance and instruction-data separation; passing these is not a clinical validation or proof of off-topic enforcement.

Maintenance: verify the primary page before changing a passage, preserve a unique passage ID, update verification date and corpus version, add realistic paraphrase tests, and run repository checks. Do not silently import unreviewed user uploads or retrieved web instructions. If a source changes or no longer supports a passage, revise or remove it before release. No automated primary-source refresh or stale-source blocking is implemented yet; backend snapshot distribution is described below.

The corpus does not provide disease-specific diets, supplement dosing, allergy safety certification, or personalized medical advice. It does not replace real food catalog data. Live voice grounding remains to be evaluated after funding the API account.


## Next layer: backend master and offline tablet cache

The public corpus now also covers allergen-label awareness (FDA), general meal composition (Health Canada), and food-data provenance/preparation (USDA FoodData Central). New summaries were checked October 21, 2026:

- https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know
- https://www.canada.ca/en/health-canada/services/food-guide/eating-support/cooking/make-healthy-meals-plate.html
- https://fdc.nal.usda.gov/faq/
- https://fdc.nal.usda.gov/Foundation_Foods_Documentation/

The local preview backend serves the versioned master at authenticated `GET /knowledge/nutrition`, independently of OpenAI billing. Voice startup loads the last valid tablet cache, then attempts a bounded-time backend refresh. Offline, corrupt, same-revision or older updates preserve the last good data. New valid revisions are saved in application-local storage. This updates public explanatory knowledge only; the six built-in product/formula rules cannot be overridden by a corpus update.

Snapshots have a closed schema, bounded sizes, unique IDs, source-host allowlisting, publisher/date checks, and monotonically increasing revisions. These are validation controls, not clinical review or cryptographic publisher certification. The transport assumes the configured authenticated backend is trusted. A modified device can tamper with its own local application storage; this is not a signed content system.

`nutritionKnowledgeRoute` provides an authenticated production-host route seam, but cloud hosting, registration on a deployed host, HTTPS transport configuration, rollout operations, and a content-authoring service are not deployed. The running implementation is the Mac/USB emulator preview. The conversational model remains in OpenAI cloud; no on-device language model was added. RAG still does not guarantee off-topic refusal.

## Voice product-card flow

Naming a food triggers the existing catalog search tool. The food-options screen displays the actual matches as labeled glass cards. `select_food_option` accepts A/B/C/D (or recognized spoken ordinals), checks the latest finalized audio transcript against the same current options, and selects the corresponding real product ID. A changed offer set or mismatched spoken letter is refused. Selecting a card never logs food; portion review and fresh explicit confirmation still apply.

The cards currently display labeled illustrations. Real catalog product photographs are not populated, and the corpus is not a source of product images or nutrient facts. Touch selection works without the voice provider. The voice model must still choose the correct tool; actual audio recognition and orchestration need a funded live test.
