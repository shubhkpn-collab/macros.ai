# Overnight-oats meal-prep demo

The Android development app has an explicit **Start overnight oats demo** entry point. The same flow can be started by the conversational model with `start_meal_prep`. It opens three sourced Quaker variants and keeps a meal ledger separate from daily totals. This is a curated demo, not a claim that arbitrary retailer products have complete photos or exact current labels.

## What is implemented

- Three Quaker oat variants; separate raw blueberries and strawberries; Great Value/Jif/Skippy peanut butters; four milk types; Lindt/Ghirardelli/Hershey’s dark chocolates; Optimum Nutrition/Dymatize/Body Fortress protein powders.
- Eighteen frozen product records and photo references bundled on the tablet. The demo choices do not require live grocery lookup.
- Stable A/B/C labels, A–D for milk. A spoken letter is checked against the current offer; a spoken brand/variant must identify one current card. Ambiguous or mismatched choices are refused.
- Only the selected version supplies nutrient facts. Corrections invalidate confirmation. A fresh “yes”, “confirm” or “log it” saves through the existing controller and persistence path.
- The meal panel accumulates confirmed ingredients, calories, protein, carbs and fat. Touch and voice use the same persisted-log observer. Duplicate confirmations do not duplicate meal items.
- Initial spoken grams can survive card selection. Milk inputs in this demo are grams; millilitres are not silently treated as grams.
- Ingredient order is free. The seven ingredient buttons are optional testing controls; there is no scripted voice Q&A.

## Product data and photos

`data/grocery/overnight-oats-demo.json` is the source for the generated bundle; rebuild with `npm run demo:meal-prep:build`. Most facts come from the October 2026 USDA branded release, and berries come from the checked-in USDA ingredient seed. Body Fortress uses NIH DSLD label 310115, with its declared 45 g serving and complete label macros. Original servings and source IDs are retained.

Walmart photo references remain marked **Walmart product reference**, never Open Food Facts/CC-BY-SA. Photos are manually curated variant references, not automatically verified current package labels or stock. Some sources describe another package size of the same food variant. Check the physical package before a public demo claiming package-exact nutrition. The two extra oat options now have distinct photos, not a repeated Quaker canister.

The two dairy choices are **Horizon Organic 1% Lowfat Milk** and **Organic Valley Whole Milk**, replacing the earlier Great Value reference-only selections because these sources explicitly declare gram servings. Almond milk is Silk Unsweet; oat milk is Planet Oat Extra Creamy. The two dairy photos come from exact-barcode Open Food Facts metadata; other selected photos retain their original attribution. No Great Value photo is used to represent another brand's nutrition.

## One-bowl weighing

Put the empty, untared bowl on a connected scale, wait until stable, then say “Set the bowl baseline” (or use its button). This records a software baseline; it does not claim a hardware tare occurred. Each subsequent stable capture computes the positive difference from the last confirmed gross reading. Original gross/baseline readings and device provenance are retained in the food capture.

Example: empty bowl 500 g → oats gross 580 g logs 80 g → berries gross 630 g logs 50 g. Only a successful persisted ingredient advances the baseline. New stable samples are required after each capture. Tare/device/boot changes, negative increments, stale readings and manual corrections cannot silently reuse the old baseline. A cancelled captured ingredient ends bowl mode; explicitly set a new baseline before continuing if necessary.

The scale protocol and controller support this behavior. **The development host still has no physical BLE scale transport.** Automated tests use the protocol simulator, and spoken/touch grams remain clearly manual. Hardware connection and actual physical weighing are not established by these tests.

## Test it

Without API credit: start the demo, tap ingredient choices, enter grams, confirm, and check the meal panel and dashboard. Use the ingredient buttons to move on. Finish meal prep retains its summary and does not delete logs. The current meal ledger is session-only; persisted food logs survive restart.

With credit later: start a voice session, request the overnight-oats demo, choose letters or brands, give grams or capture the connected scale, confirm each ingredient, then finish the meal. Natural speech timing, interruptions and model-selected clarifications require a live model test. Wake-word activation is not added by this change.

## Verification

This build passed root and tablet TypeScript checks and Android `assembleKitchenPreview`. Full repository verification: 2,337 tests, 2,328 passed, nine skipped, zero failed. Nine focused tests cover the full seven-ingredient session, all choice counts, voice brands/letters, initial quantity memory, duplicate confirmation, touch parity, two successive bowl increments, tare invalidation and invalid capture evidence. No paid model calls were made. No device was attached for installation or visual acceptance.
