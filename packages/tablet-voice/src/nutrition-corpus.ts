import type {KitchenKnowledgePassage} from './kitchen-knowledge.js';
/** Authored summaries of fetched primary sources, not automatically trusted web instructions. */
export const NUTRITION_CORPUS: readonly KitchenKnowledgePassage[] = [
  {
    "id": "label-serving-v1",
    "title": "Serving size versus portion",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "serving",
      "portion",
      "label",
      "package",
      "container"
    ],
    "text": "A label serving describes a commonly consumed amount, not an instruction about how much to eat. Check servings per package and match the labeled basis to your portion."
  },
  {
    "id": "label-energy-v1",
    "title": "Calories on a food label",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "calories",
      "energy",
      "label",
      "serving"
    ],
    "text": "Labeled calories describe energy for the stated serving. Eating multiple servings changes the amount consumed. Use the food calculation tool for your actual portion rather than treating the package as one serving."
  },
  {
    "id": "label-sugar-v1",
    "title": "Total sugar and added sugar",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "sugar",
      "sugars",
      "added",
      "honey",
      "syrup",
      "sweetener"
    ],
    "text": "Total sugar includes naturally present and added sugars. Added sugar is part of that total, not an additional amount to add again. Honey and syrups can contribute added sugars."
  },
  {
    "id": "label-dv-v1",
    "title": "What percent Daily Value means",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "daily",
      "value",
      "dv",
      "percent",
      "percentage",
      "high",
      "low",
      "label"
    ],
    "text": "Percent Daily Value compares one serving with a general daily reference. FDA considers 5% or less low and 20% or more high. It is not your personalized macro target."
  },
  {
    "id": "label-comparison-v1",
    "title": "Comparing packaged foods",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "compare",
      "comparison",
      "labels",
      "sodium",
      "saturated",
      "fat",
      "fiber",
      "fibre"
    ],
    "text": "Compare similar serving amounts. FDA encourages attention to fiber and key micronutrients while limiting sodium, saturated fat and added sugar. Individual dietary needs can differ."
  },
  {
    "id": "label-columns-v1",
    "title": "Per serving versus per package",
    "source": "https://www.fda.gov/food/nutrition-facts-label/how-understand-and-use-nutrition-facts-label",
    "publisher": "FDA",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "column",
      "columns",
      "package",
      "container",
      "serving",
      "entire",
      "whole",
      "bag"
    ],
    "text": "Some labels show both serving and package totals. Choose the column corresponding to what you actually consume; do not combine the two columns."
  },
  {
    "id": "clean-hands-v1",
    "title": "Kitchen hand washing",
    "source": "https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "wash",
      "washing",
      "hands",
      "soap",
      "clean",
      "hygiene"
    ],
    "text": "Wash hands with soap and water for at least 20 seconds, including after handling raw animal foods. Clean utensils and surfaces after use."
  },
  {
    "id": "clean-produce-v1",
    "title": "Washing produce and raw poultry",
    "source": "https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "wash",
      "washing",
      "rinse",
      "produce",
      "vegetables",
      "fruit",
      "chicken",
      "poultry",
      "meat"
    ],
    "text": "Rinse produce under running water without soap or bleach. Do not rinse raw meat or poultry; splashes can spread germs around the kitchen."
  },
  {
    "id": "clean-separate-v1",
    "title": "Preventing cross contamination",
    "source": "https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "cross",
      "contamination",
      "board",
      "boards",
      "raw",
      "cooked",
      "separate",
      "utensils"
    ],
    "text": "Keep raw animal foods separate from ready-to-eat foods. Use separate boards and plates, and wash equipment that touched raw food before reuse."
  },
  {
    "id": "clean-chill-v1",
    "title": "Refrigerating a prepared meal",
    "source": "https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "refrigerate",
      "refrigeration",
      "room",
      "temperature",
      "hours",
      "picnic",
      "leftovers",
      "cooling"
    ],
    "text": "Refrigerate perishable food within two hours, or one hour above 90\u00b0F/32\u00b0C. Use shallow containers for prompt cooling. Keep the refrigerator at 40\u00b0F/4\u00b0C or colder."
  },
  {
    "id": "clean-thaw-v1",
    "title": "Thawing and marinating",
    "source": "https://www.foodsafety.gov/keep-food-safe/4-steps-to-food-safety",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "thaw",
      "thawing",
      "defrost",
      "marinate",
      "marinating",
      "counter",
      "frozen",
      "freezing"
    ],
    "text": "Thaw or marinate meat, poultry and seafood in the refrigerator rather than on the counter. Freezing does not reliably kill harmful germs."
  },
  {
    "id": "cook-poultry-v1",
    "title": "Chicken and turkey cooking temperature",
    "source": "https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "chicken",
      "turkey",
      "poultry",
      "cook",
      "cooking",
      "temperature",
      "thermometer"
    ],
    "text": "Poultry, including ground poultry, should reach 165\u00b0F/74\u00b0C internally. Check with a food thermometer; appearance alone cannot establish a safe internal temperature."
  },
  {
    "id": "cook-ground-v1",
    "title": "Ground meat cooking temperature",
    "source": "https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "ground",
      "beef",
      "mince",
      "minced",
      "hamburger",
      "burger",
      "sausage",
      "temperature"
    ],
    "text": "Ground beef and other listed ground meats need 160\u00b0F/71\u00b0C. Ground poultry instead needs 165\u00b0F/74\u00b0C. Identify the meat before choosing the temperature."
  },
  {
    "id": "cook-steak-v1",
    "title": "Steaks, chops and roasts",
    "source": "https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "steak",
      "steaks",
      "chops",
      "roast",
      "roasts",
      "pork",
      "beef",
      "lamb",
      "rest",
      "temperature"
    ],
    "text": "Whole cuts of beef, pork and lamb should reach 145\u00b0F/63\u00b0C followed by three minutes of rest. This rule differs from the ground-meat rule."
  },
  {
    "id": "cook-leftovers-v1",
    "title": "Reheating leftovers",
    "source": "https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "reheat",
      "reheating",
      "leftovers",
      "casserole",
      "casseroles",
      "temperature"
    ],
    "text": "Reheat leftovers and cook casseroles to 165\u00b0F/74\u00b0C internally. Verify with a food thermometer rather than relying only on whether the surface feels hot."
  },
  {
    "id": "store-leftovers-v1",
    "title": "How long cooked leftovers keep",
    "source": "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "leftover",
      "leftovers",
      "fridge",
      "refrigerator",
      "cooked",
      "chicken",
      "meat",
      "storage",
      "days"
    ],
    "text": "The refrigerated storage guide lists cooked meat or poultry leftovers for three to four days at 40\u00b0F/4\u00b0C or below. This assumes appropriate handling and prompt refrigeration."
  },
  {
    "id": "store-eggs-v1",
    "title": "Storing eggs and prepared soups",
    "source": "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
    "publisher": "FoodSafety.gov",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "eggs",
      "egg",
      "boiled",
      "soup",
      "soups",
      "stew",
      "storage",
      "fridge",
      "days"
    ],
    "text": "The refrigerated guide lists hard-cooked eggs for one week and soups or stews for three to four days. Storage duration depends on the food and proper temperature."
  },
  {
    "id": "sport-protein-v1",
    "title": "Protein and muscle recovery",
    "source": "https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-Consumer/",
    "publisher": "NIH Office of Dietary Supplements",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "protein",
      "muscle",
      "muscles",
      "recovery",
      "recover",
      "exercise",
      "workout",
      "training"
    ],
    "text": "Protein supplies amino acids used to maintain and repair muscle. Needs depend on the person and training; obtain your MACROS target from the state tool rather than a generic statement."
  },
  {
    "id": "sport-plants-v1",
    "title": "Protein from plant foods",
    "source": "https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-Consumer/",
    "publisher": "NIH Office of Dietary Supplements",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "plant",
      "plants",
      "vegan",
      "vegetarian",
      "legumes",
      "beans",
      "grain",
      "grains",
      "amino",
      "acids"
    ],
    "text": "Different plant foods provide different essential amino acids. A varied plant-based diet can supply them. Do not infer an individual food\u2019s protein amount without catalog evidence."
  },
  {
    "id": "sport-powder-v1",
    "title": "Do I need protein powder?",
    "source": "https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-Consumer/",
    "publisher": "NIH Office of Dietary Supplements",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "powder",
      "powders",
      "shake",
      "shakes",
      "supplement",
      "supplements",
      "whey",
      "protein"
    ],
    "text": "Many athletes can meet protein needs through food. Protein supplements may help when intake is otherwise insufficient; a powder is not automatically necessary for training."
  },
  {
    "id": "sport-bcaa-v1",
    "title": "BCAA supplements",
    "source": "https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-Consumer/",
    "publisher": "NIH Office of Dietary Supplements",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "bcaa",
      "bcaas",
      "branched",
      "chain",
      "amino",
      "supplement",
      "supplements",
      "recovery"
    ],
    "text": "NIH describes limited evidence that BCAA supplements improve performance or muscle outcomes beyond adequate high-quality protein. Protein-containing foods already supply these amino acids."
  },
  {
    "id": "water-needs-v1",
    "title": "Hydration needs vary",
    "source": "https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html",
    "publisher": "CDC",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "water",
      "hydration",
      "hydrate",
      "hydrated",
      "fluids",
      "thirsty",
      "thirst",
      "heat",
      "exercise"
    ],
    "text": "Fluid needs vary with personal factors and conditions such as activity and heat. Avoid assigning everyone the same water target. Water-containing foods and beverages also contribute."
  },
  {
    "id": "water-swaps-v1",
    "title": "Choosing everyday drinks",
    "source": "https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html",
    "publisher": "CDC",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "drink",
      "drinks",
      "beverage",
      "beverages",
      "soda",
      "sweetened",
      "water",
      "sugar"
    ],
    "text": "Plain water is a useful alternative to sugary drinks. Replacing a sugary beverage with water can reduce beverage calories; actual amounts require the product\u2019s nutrition data."
  },
  {
    "id": "water-routine-v1",
    "title": "Making water accessible",
    "source": "https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html",
    "publisher": "CDC",
    "verifiedAt": "2026-10-14",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "keywords": [
      "water",
      "bottle",
      "meal",
      "meals",
      "hydration",
      "routine",
      "habit"
    ],
    "text": "Keeping water available, carrying a reusable bottle and choosing water with meals can help build a hydration routine. These are general habits rather than a medical fluid prescription."
  },
  {
    "id": "allergy-major-v1",
    "title": "Recognizing major food allergens",
    "source": "https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "FDA",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "allergen",
      "allergens",
      "allergy",
      "allergies",
      "sesame",
      "peanuts",
      "wheat",
      "dairy",
      "soy",
      "shellfish"
    ],
    "text": "US labeling recognizes milk, eggs, fish, crustacean shellfish, tree nuts, peanuts, wheat, soybeans and sesame as major allergens. Other foods can also cause allergies; the list is not exhaustive."
  },
  {
    "id": "allergy-label-v1",
    "title": "Checking ingredients for allergens",
    "source": "https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "FDA",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "allergy",
      "allergen",
      "ingredients",
      "contains",
      "label",
      "package",
      "packaging"
    ],
    "text": "Check the current package ingredient list and allergen declaration. Major allergen sources must be identified under applicable US labeling rules. A generic catalog entry cannot certify a specific package as safe."
  },
  {
    "id": "allergy-contact-v1",
    "title": "Allergen cross-contact and uncertainty",
    "source": "https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "FDA",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "allergen",
      "allergy",
      "cross",
      "contact",
      "may",
      "contain",
      "shared",
      "equipment",
      "safe"
    ],
    "text": "Unintended allergen contact can occur during preparation or manufacturing. Do not infer that a food is safe from its name or photo. Follow the person\u2019s allergy-management plan and clarify uncertain ingredients."
  },
  {
    "id": "plate-proportions-v1",
    "title": "A balanced meal plate",
    "source": "https://www.canada.ca/en/health-canada/services/food-guide/eating-support/cooking/make-healthy-meals-plate.html",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "Health Canada",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "balanced",
      "balance",
      "plate",
      "vegetables",
      "fruit",
      "grains",
      "protein",
      "meal"
    ],
    "text": "Health Canada presents a plate with half vegetables and fruit, one-quarter whole grains and one-quarter protein foods. These proportions are a general reference, not a prescribed personal calorie or macro target."
  },
  {
    "id": "plate-variety-v1",
    "title": "Flexible ingredients for meals",
    "source": "https://www.canada.ca/en/health-canada/services/food-guide/eating-support/cooking/make-healthy-meals-plate.html",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "Health Canada",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "fresh",
      "frozen",
      "canned",
      "dried",
      "vegetables",
      "fruit",
      "variety",
      "budget"
    ],
    "text": "Healthy food choices can include fresh, frozen, canned and dried foods. Choose variety and foods you enjoy; the guide\u2019s pictured foods are examples rather than the only permitted ingredients."
  },
  {
    "id": "plate-mixed-v1",
    "title": "Mixed dishes and bowl meals",
    "source": "https://www.canada.ca/en/health-canada/services/food-guide/eating-support/cooking/make-healthy-meals-plate.html",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "Health Canada",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "mixed",
      "dish",
      "dishes",
      "bowl",
      "bowls",
      "curry",
      "stir",
      "fry",
      "soup",
      "meal"
    ],
    "text": "Meal proportions can guide choices in bowls and mixed dishes as well as on plates. Consider the ingredients together rather than requiring each food group to occupy a separate compartment."
  },
  {
    "id": "plate-portion-v1",
    "title": "Plate pictures are not portion prescriptions",
    "source": "https://www.canada.ca/en/health-canada/services/food-guide/eating-support/cooking/make-healthy-meals-plate.html",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "Health Canada",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "portion",
      "portions",
      "plate",
      "picture",
      "pictures",
      "amount",
      "grams",
      "size"
    ],
    "text": "The size of foods pictured in Canada\u2019s guide is not a recommended quantity for one sitting. Use personal needs and the application\u2019s measured portion and target tools for actual amounts."
  },
  {
    "id": "fdc-types-v1",
    "title": "Different types of food composition evidence",
    "source": "https://fdc.nal.usda.gov/faq/",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "USDA FoodData Central",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "usda",
      "fdc",
      "foundation",
      "branded",
      "database",
      "data",
      "nutrient",
      "evidence",
      "label"
    ],
    "text": "FoodData Central combines multiple data types. Branded-food values originate from product-label information, while other datasets serve different purposes. Do not treat every entry as an identical laboratory measurement."
  },
  {
    "id": "fdc-updates-v1",
    "title": "Changing branded product data",
    "source": "https://fdc.nal.usda.gov/faq/",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "USDA FoodData Central",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "brand",
      "branded",
      "product",
      "reformulation",
      "changed",
      "label",
      "update",
      "database"
    ],
    "text": "FoodData Central accommodates changes in branded foods. Product identity and the current package matter when comparing data. MACROS should use the selected catalog version rather than silently substituting another food."
  },
  {
    "id": "fdc-preparation-v1",
    "title": "Matching raw and cooked food descriptions",
    "source": "https://fdc.nal.usda.gov/Foundation_Foods_Documentation/",
    "reviewStatus": "PUBLIC_SOURCE_SUMMARY",
    "publisher": "USDA FoodData Central",
    "verifiedAt": "2026-10-21",
    "keywords": [
      "raw",
      "cooked",
      "preparation",
      "usda",
      "description",
      "cooking",
      "food",
      "database"
    ],
    "text": "Foundation Foods descriptions include characteristics such as raw or cooked state. Match the description to the food being weighed. A related-looking entry is not evidence that its nutrient values apply to your portion."
  }
];
