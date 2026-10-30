# Branded catalog and package photos

The local preview backend now searches the **official October 2026 USDA branded-food release on disk**, rather than requiring a live USDA API call for each search. The tablet receives up to sixteen immutable versions through the existing authenticated grocery endpoint. Its existing card selection, portion calculations and durable cache remain in charge of logging.

## Reproduce

Official release listing: https://fdc.nal.usda.gov/download-datasets/

1. Download `https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_json_2026-10-29.zip` into ignored `data/sources/`.
2. Run `npm run catalog:branded:build -- data/sources/FoodData_Central_branded_food_json_2026-10-29.zip`.
3. Download the official Open Food Facts export from `https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz` into ignored `data/sources/`.
4. Run `npm run catalog:photos:import -- data/sources/openfoodfacts-products.csv.gz`.
5. Restart `npm run voice:backend`. Reconnect the preview app after restarting because its local connection token changes.

The full index and photo metadata live under ignored `data/runtime/`. They are built locally, not committed as a large Git database. The committed reports include source checksums and measured counts. The generator streams the release; the tablet never parses hundreds of megabytes of catalog data.

## Inclusion and identity

The USDA release contains 434,001 source records. This build accepts 246,328 records, representing **246,327 unique barcodes and 28,454 source brand names**. It requires US-market records, active listings in the source, a valid GTIN, gram-based serving units and complete, plausible calorie/protein/carbohydrate/fat values with declared units. Other records are excluded rather than assigned inferred densities or missing nutrients. For a repeated GTIN, the newest source publication wins, then highest source ID. No products are joined by name alone.

Facts retain FDC identity, original serving/ingredients when supplied, archive checksum, release and content-derived version. Search syntax is tokenized and bound, and results are validated before delivery. USDA listing presence is not proof of current retailer availability or a current physical package.

## Photos and licenses

Photo metadata is joined from the Open Food Facts export only when its normalized barcode exactly matches a USDA product. The bulk operation downloads metadata, not image files. Product cards load attributed remote images. The existing exact-barcode Open Food Facts API can fill missing metadata for a bounded number of visible options, with request pacing and retryable transient failures. Photos persist across backend restarts in a separate SQLite store. Missing photos stay explicitly illustrated; no stock photo is substituted for a branded package.

USDA nutrients remain in a separate public-domain data index. Open Food Facts metadata attribution and ODbL-1.0 provenance are retained separately; images carry CC-BY-SA-3.0 attribution and source links. A reusable, separately licensed metadata export is generated at `data/runtime/branded-photo-metadata.ndjson.gz`. Preserve these notices and applicable share-alike requirements when distributing the data. Official licensing: https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/

## Limits

This is broad branded-food coverage, **not all grocery products or guaranteed photos for every item**. Volume-only labels, incomplete data, missing barcodes and missing photos remain coverage gaps. Barcode matching is not a manual visual review; packaging and remote image availability can change. The photo report measures matched image metadata, not successful downloads of every image. See `data/grocery/branded-photo-report.json` for measured coverage.

The full branded index lives on the Mac backend in this preview. Only saved selections and their metadata are cached on the tablet; the entire branded catalog is not installed offline there. A deployed service or a separate device-index implementation is needed for standalone customer use. No retailer feed or paid voice testing is added by this work.

## Measured result

The Open Food Facts export contained 4,883,869 rows. Of these, 222,360 matched catalog barcodes and 50,898 had usable front-image metadata: **20.66%** photo coverage of the 246,327-product index. The other products retain a missing-photo state. These are metadata counts, not a claim that every remote image was visually checked.

Run `npm run catalog:branded:audit` to scan every catalog record and photo join. The completed audit found **zero invalid products, zero invalid photo-metadata records and zero orphan photo joins**. Its sample searches measure result availability, not a comprehensive consumer relevance benchmark. End-to-end authenticated HTTP checks returned 16 Quaker oat products (11 photos) and 16 Great Value peanut butter products (nine photos).
