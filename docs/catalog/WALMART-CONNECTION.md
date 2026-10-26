# Walmart US national grocery catalog connection

Scope confirmed October 25, 2026: Walmart US, national online grocery listings. Other stores are deferred. A national listing does not assert local pickup inventory or delivery eligibility.

## Verified access routes

1. **Walmart catalog snapshot / partner feed**: Walmart documents an OAuth-protected catalog snapshot endpoint and a download URL for product feeds. This is the most relevant official route to request for bulk catalog ingestion, subject to Walmart approving the actual use case. Credentials and granted feed scope are prerequisites, not outputs MACROS can generate.
   - https://www.walmart.io/docs/opd/recipe-register/catalog-product-snapshot
   - https://walmart.io/docs/dv-volt-api/v1/introduction/
2. **Affiliate program**: Walmart advertises product feeds for approved affiliates. Its published API terms limit normal use to advertising Walmart products and require express permission for other uses; MACROS must disclose nutrition matching and in-app photo display instead of assuming affiliate enrollment grants those rights.
   - https://affiliates.walmart.com/
   - https://affiliates.walmart.com/page/contact-us
   - https://walmart.io/termsandcondition
3. **Marketplace item search**: The authenticated Marketplace API searches published Walmart.com items. Marketplace seller/solution-provider onboarding is aimed at seller workflows; it is not an unrestricted public grocery API or proof that a nutrition appliance qualifies.
   - https://developer.walmart.com/global-marketplace/reference/getsearchresult
   - https://developer.walmart.com/global-marketplace/page/getting-started

No Walmart account was created, no application/terms accepted, no message sent, and no credentials obtained. No authorized Walmart source is configured. This research is not a completed connection or a downloaded Walmart catalog.

## Prepared access request — not sent

**Subject:** MACROS.AI — request for US grocery catalog access and permitted nutrition-assistant use

Hello Walmart partner team,

MACROS.AI is an Android kitchen nutrition-assistant prototype. We are requesting the appropriate official access route for Walmart US national online grocery listings. Users would describe a food by voice, see matching product cards, explicitly select a product, provide or measure a portion, and confirm food logging.

We need Walmart item IDs, product and brand/variant names, UPC/GTIN, package size, product-page links, grocery category, product images with permitted attribution/display terms, published/unpublished status and update timestamps. We would like a bulk initial snapshot and an approved incremental update or search mechanism.

Please confirm whether this nutrition-assistant use is permitted, including caching catalog identifiers, displaying product photos on an Android appliance, matching exact barcodes to independently sourced nutrient records, and retaining immutable product facts for food-log history. We are not seeking to claim local store availability or to ingest customer account/purchase data.

Please advise on eligibility, credentials, feed scope, required attribution, storage/deletion restrictions, refresh requirements, fees and the appropriate application process. If affiliate access alone does not permit this use, please direct us to the relevant partnership or data-licensing team.

Business/legal name, contact name/email, published product website and expected pilot scale will be supplied by the owner during onboarding. MACROS is currently a prototype, not a Walmart-approved partner.

Thank you.

## Implementation prepared

- Normalized US/national listing snapshot contract and strict Walmart product URL/item ID checks.
- Exact validated GTIN join to existing immutable nutrient products. Brand/name similarity cannot establish Walmart listing evidence.
- Unpublished listings, invalid barcodes and ambiguous listing matches are excluded, with unmatched/ambiguous counts.
- Walmart-only discovery targets replace the former five-store target list.
- Existing A–D cards, spoken choice validation, portion calculations and fresh-confirmation logging remain the application path. The new listing matcher is a tested building block, not yet wired to a live feed or represented as populated in the app.

## Remaining work after access is granted

Inspect an actual approved feed before implementing its field adapter. Build resumable ingestion with source hashes and update/unpublish handling. Match nutrition by exact product identity; keep raw/cooked/cut/skin/variant distinctions and do not guess fluid density. Measure unmatched foods and photo coverage against representative Walmart grocery baskets. Verify the right to display and retain each source's images/data. Then connect the validated Walmart candidates to the shared voice/touch search and run native acceptance tests before the paid voice round.

The existing 11 USDA seed records do not count as verified Walmart coverage. There is no basis yet to claim every Walmart grocery is present, and no fixed completion date until source access and actual feed coverage are known.
