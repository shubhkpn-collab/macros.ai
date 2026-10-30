# Kitchen food library

The development tablet now bundles **6,877 USDA ingredient records across 24 food categories** from the repository's existing USDA seed. It uses these as the real-food fallback underneath the existing branded grocery search and durable cache. No external API or paid voice call is needed to search bundled ingredients.

## Coverage and identity

The bundle contains 1,480 raw, 2,194 cooked and 3,203 as-sold records. Examples include oats, tomatoes, chicken, rice, tofu, milk, lentils, eggs, fish, potatoes, oils and fruit. Raw and cooked records remain distinct; no yield factors, densities, package photos or brand identities are invented. The coverage report counts description matches, not search quality or retailer availability.

Every version preserves source record identity, release, archive fingerprint, preparation and the four source macro values. Publication time is unknown in this seed and is represented by epoch, not today's date. Data is automatically validated, not newly clinically or manufacturer reviewed. The original source archives have not been fetched again by this build.

Rebuild with `npm run catalog:kitchen:build`. The generator rejects missing or implausible macros, incorrect units, unknown sources, duplicate identities and unresolved preparation. It writes the tablet bundle and `data/grocery/kitchen-library-report.json`. Source changes create different immutable version IDs; saved logs keep their original snapshots.

## Cooking conversation

The same search/controller handles voice and touch. Amounts spoken during a food search can survive card selection for the same pending flow, with a two-minute bound. New conflicting quantities cannot revive older amounts. Review corrections invalidate confirmation; a fresh “yes”, “confirm” or “log it” can save the current review. Saved ingredients return to the same cooking session rather than requiring a new conversation.

## Remaining coverage gaps

This is a broad ingredient library, **not a comprehensive retail catalog**. Exact branded variants and photos remain dependent on the existing USDA branded search and exact-barcode Open Food Facts image lookup; missing products stay missing. No retailer listing or stock claim is implied. Mixed dishes require known ingredients and portion allocation; a dish name alone cannot establish an exact recipe. Volume portions, undoing saved logs, wake word and a physical wireless scale are not added by this catalog build.

Live voice quality, clarification choices and interruptions still need end-to-end testing later. Offline tests exercise application tools using transcripts, not an LLM conversation. The development profile/activity/scale remain synthetic; food sources carry their own provenance.

## Verification for this expansion

- Full repository verification: 2,324 tests, 2,315 passed, nine skipped, zero failed.
- Final conversation-tool checks: 23 passed, zero failed; no paid model calls.
- Full-catalog search checks cover oats, tomatoes, rice, chicken, tofu, milk, lentils and salmon through the application controller.
- Root and tablet type checks passed before final packaging; final tablet compilation and Android packaging are checked separately.
- No connected device was present for installation or visual testing. Live voice, wake word and physical scale testing remain pending.
