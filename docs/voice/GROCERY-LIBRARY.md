# Grocery product library for the kitchen pilot

The product catalog is separate from the nutrition explanation/RAG library. The requested experience is: name a food or brand → real candidate products appear as A–D cards → say a letter → review the actual measured/manual grams → confirm the log. Touch and voice use the same controller and repository, so a spoken letter refers to the cards currently offered.

## Implemented preview

- Authenticated local backend search of USDA FoodData Central branded foods. OpenAI credit is not used for this lookup. The provider key stays on the Mac backend.
- A bounded candidate query prevents loading the entire branded database onto the tablet. Cached immutable versions remain available for historical logs and offline searches after restart. The preview cache retains at most 2,000 versions; it refuses additional uncached versions rather than evicting facts referenced by logs.
- Products must have energy, all three macros, a valid GTIN and a defensible gram serving. Volume-only records are omitted; no density is guessed. This means beverages and some other groceries are not covered yet.
- Photos are requested separately from Open Food Facts using the exact barcode. A matching barcode is an identity check, not proof that a photo depicts the latest packaging. Missing or failed images remain explicitly labeled illustrations. The preview does not guarantee photos for every result.
- Cards show the brand, label serving description when supplied, USDA attribution and photo attribution. Searching/selecting does not save food; existing fresh-confirmation guards still apply.
- The committed seed contains 11 actual USDA records and 2 photo references fetched October 21, 2026. This is a small fallback sample, not a broad downloaded catalog. Try `Great Value peanut butter` with the local backend running.

## Data sources and limits

[USDA API guide](https://fdc.nal.usda.gov/api-guide/) describes branded-food search, CC0 data and access limits. Its shared demo key permits only 30 hourly / 50 daily requests per IP. A personal data.gov key is needed for sustained testing. Set `USDA_API_KEY` in the existing ignored `.env.realtime.local` file on the Mac and restart the preview backend. Never put that key in the Android app or Git.

[Open Food Facts source licensing](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/tutorials/license-be-on-the-legal-side.md) distinguishes the ODbL database from CC BY-SA 3.0 product images. This preview imports no OFF nutrition facts; it keeps separately attributed image references. Product imagery can carry additional third-party rights. Source/licensing review is still required before commercial distribution.

This is not a retailer inventory connection. A product in USDA is not proof that Walmart, Costco, Jewel-Osco, Whole Foods or Trader Joe’s currently sells it, nor that its package label is unchanged. No prices, stock status or retailer endorsements are inferred.

## Coverage acceptance

`data/grocery/coverage-targets.json` defines 50 discovery searches across the five requested stores' associated brands and common food categories. It is a target set, not a report of achieved coverage. For a representative customer basket, record separately:

1. Exact product/variant/size found, with barcode and source date.
2. Complete nutrient facts and usable gram basis.
3. Correct package photo available, missing, or outdated.
4. Natural spoken search resolves useful candidates; letter selection chooses exactly the displayed version.
5. A correction or interruption cannot cause a wrong or duplicate log.

Before a month-long external pilot, choose basket-based coverage and task-success thresholds; finish photo/variant review, fluid portions, real account isolation, production backend hosting, privacy/deletion flows and live voice evaluation. Automated adapter tests and a large upstream database do not establish these outcomes. This preview is not ready to hand to unrelated users for a month.
