# Nutrition knowledge in continuous voice

The continuous audio session now exposes `retrieve_nutrition_knowledge`. It retrieves up to three versioned, source-linked passages from a curated local corpus of 30 passages: six existing product-rule explanations and 24 public-source summaries. Coverage includes the energy budget, macro policy, activity quality, portions, confirmation, next-food workflow, labels, hydration, sports-protein questions, and food safety.

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

These are short authored summaries, not full-page copies. The checked-in corpus is bundled with the Android app, requires no embedding service, and does not browse during a conversation. Relevance ranking weights distinctive query terms and passage titles, returning at most three passages. Twenty-two knowledge tests currently exercise retrieval, unsupported queries, provenance and instruction-data separation; passing these is not a clinical validation or proof of off-topic enforcement.

Maintenance: verify the primary page before changing a passage, preserve a unique passage ID, update verification date and corpus version, add realistic paraphrase tests, and run repository checks. Do not silently import unreviewed user uploads or retrieved web instructions. If a source changes or no longer supports a passage, revise or remove it before release. No automated source refresh or stale-source blocking is implemented yet.

The corpus does not provide disease-specific diets, supplement dosing, allergy safety certification, or personalized medical advice. It does not replace real food catalog data. Live voice grounding remains to be evaluated after funding the API account.
