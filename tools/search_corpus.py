"""
SEARCH-1 GOLDEN CORPUS.

Each entry: (query, category, required_any, forbidden, expectation)

`required_any` is a list of token GROUPS: a relevant result must contain at
least one token from EVERY group. That expresses "chicken AND breast" without
pinning a single product id, which would make the benchmark brittle for foods
the catalog legitimately carries many times.

`forbidden` is the safety half. For `chiken breast`, turkey is forbidden: a
result containing it is not merely irrelevant, it is an UNSAFE WRONG ANSWER.

`expectation` is one of:
  resolve   — a confident answer is correct
  ambiguous — several distinct foods are genuinely valid
  absent    — nothing in the catalog should answer this
"""

# --- proteins ------------------------------------------------------------
PROTEIN = [
    ("chicken breast", ["chicken"], ["turkey", "pork", "beef"], "ambiguous"),
    ("cooked chicken breast", ["chicken"], ["turkey", "pork"], "resolve"),
    ("raw chicken breast", ["chicken"], ["turkey", "pork"], "resolve"),
    ("grilled chicken", ["chicken"], ["turkey"], "resolve"),
    ("chicken thigh", ["chicken"], ["turkey"], "resolve"),
    ("ground beef", ["beef"], ["chicken", "turkey", "pork"], "resolve"),
    ("lean ground beef", ["beef"], ["chicken", "turkey"], "resolve"),
    ("steak", ["steak", "beef"], ["chicken"], "ambiguous"),
    ("pork chop", ["pork"], ["chicken", "beef"], "resolve"),
    ("bacon", ["bacon"], [], "resolve"),
    ("turkey breast", ["turkey"], ["chicken"], "resolve"),
    ("ground turkey", ["turkey"], ["chicken", "beef"], "resolve"),
    ("salmon", ["salmon"], ["tuna"], "resolve"),
    ("grilled salmon", ["salmon"], ["tuna"], "resolve"),
    ("canned tuna", ["tuna"], ["salmon"], "resolve"),
    ("tuna", ["tuna"], ["salmon"], "resolve"),
    ("shrimp", ["shrimp"], [], "resolve"),
    ("cod", ["cod"], [], "resolve"),
    ("tilapia", ["tilapia"], [], "resolve"),
    ("lamb", ["lamb"], ["beef", "pork"], "resolve"),
    ("ham", ["ham"], ["turkey"], "resolve"),
    ("sausage", ["sausage"], [], "resolve"),
    ("eggs", ["egg"], [], "resolve"),
    ("egg", ["egg"], [], "resolve"),
    ("boiled egg", ["egg"], [], "resolve"),
    ("scrambled eggs", ["egg"], [], "resolve"),
    ("egg white", ["egg"], [], "resolve"),
    ("tofu", ["tofu"], ["tempeh"], "resolve"),
    ("firm tofu", ["tofu"], [], "resolve"),
    ("tempeh", ["tempeh"], ["tofu"], "resolve"),
    ("whey protein", ["whey", "protein"], [], "resolve"),
    ("protein powder", ["protein"], [], "resolve"),
]

# --- grains and starches --------------------------------------------------
GRAIN = [
    ("white rice", ["rice"], [], "resolve"),
    ("brown rice", ["rice"], [], "resolve"),
    ("white rice cooked", ["rice"], [], "resolve"),
    ("basmati rice", ["rice"], [], "resolve"),
    ("jasmine rice", ["rice"], [], "resolve"),
    ("pasta", ["pasta", "macaroni", "spaghetti"], [], "ambiguous"),
    ("spaghetti", ["spaghetti", "pasta"], [], "resolve"),
    ("penne", ["penne", "pasta"], [], "resolve"),
    ("bread", ["bread"], [], "ambiguous"),
    ("white bread", ["bread"], [], "resolve"),
    ("whole wheat bread", ["bread", "wheat"], [], "resolve"),
    ("sourdough", ["sourdough"], [], "resolve"),
    ("bagel", ["bagel"], [], "resolve"),
    ("tortilla", ["tortilla"], [], "resolve"),
    ("oats", ["oat"], [], "resolve"),
    ("rolled oats", ["oat"], [], "resolve"),
    ("oatmeal", ["oat"], [], "resolve"),
    ("quinoa", ["quinoa"], [], "resolve"),
    ("couscous", ["couscous"], [], "resolve"),
    ("barley", ["barley"], [], "resolve"),
    ("cereal", ["cereal"], [], "ambiguous"),
    ("potato", ["potato"], ["sweet"], "ambiguous"),
    ("baked potato", ["potato"], [], "resolve"),
    ("sweet potato", ["potato"], [], "resolve"),
    ("mashed potatoes", ["potato"], [], "resolve"),
    ("french fries", ["fries", "potato"], [], "resolve"),
    ("corn", ["corn"], [], "ambiguous"),
    ("noodles", ["noodle"], [], "ambiguous"),
]

# --- dairy ---------------------------------------------------------------
DAIRY = [
    ("whole milk", ["milk"], [], "resolve"),
    ("skim milk", ["milk"], [], "resolve"),
    ("milk", ["milk"], [], "ambiguous"),
    ("almond milk", ["almond", "milk"], [], "resolve"),
    ("oat milk", ["oat", "milk"], [], "resolve"),
    ("greek yogurt", ["yogurt"], [], "resolve"),
    ("yogurt", ["yogurt"], [], "ambiguous"),
    ("plain yogurt", ["yogurt"], [], "resolve"),
    ("cheddar cheese", ["cheddar"], [], "resolve"),
    ("mozzarella", ["mozzarella"], [], "resolve"),
    ("parmesan", ["parmesan"], [], "resolve"),
    ("cottage cheese", ["cottage"], [], "resolve"),
    ("cream cheese", ["cream", "cheese"], [], "resolve"),
    ("butter", ["butter"], ["peanut"], "ambiguous"),
    ("heavy cream", ["cream"], [], "resolve"),
    ("sour cream", ["cream"], [], "resolve"),
    ("feta", ["feta"], [], "resolve"),
    ("swiss cheese", ["swiss"], [], "resolve"),
]

# --- produce -------------------------------------------------------------
PRODUCE = [
    ("banana", ["banana"], [], "resolve"),
    ("apple", ["apple"], [], "ambiguous"),
    ("orange", ["orange"], [], "ambiguous"),
    ("strawberries", ["strawberr"], [], "resolve"),
    ("blueberries", ["blueberr"], [], "resolve"),
    ("grapes", ["grape"], [], "resolve"),
    ("avocado", ["avocado"], [], "resolve"),
    ("broccoli", ["broccoli"], [], "resolve"),
    ("spinach", ["spinach"], [], "resolve"),
    ("kale", ["kale"], [], "resolve"),
    ("carrot", ["carrot"], [], "resolve"),
    ("tomato", ["tomato"], [], "ambiguous"),
    ("cucumber", ["cucumber"], [], "resolve"),
    ("lettuce", ["lettuce"], [], "resolve"),
    ("onion", ["onion"], [], "resolve"),
    ("garlic", ["garlic"], [], "resolve"),
    ("bell pepper", ["pepper"], [], "resolve"),
    ("mushrooms", ["mushroom"], [], "resolve"),
    ("green beans", ["bean"], [], "resolve"),
    ("peas", ["pea"], [], "resolve"),
    ("cauliflower", ["cauliflower"], [], "resolve"),
    ("zucchini", ["zucchini"], [], "resolve"),
    ("asparagus", ["asparagus"], [], "resolve"),
    ("mango", ["mango"], [], "resolve"),
    ("pineapple", ["pineapple"], [], "resolve"),
    ("watermelon", ["watermelon"], [], "resolve"),
    ("peach", ["peach"], [], "resolve"),
    ("pear", ["pear"], [], "resolve"),
]

# --- fats, nuts, condiments ------------------------------------------------
FATS = [
    ("peanut butter", ["peanut"], [], "resolve"),
    ("almond butter", ["almond"], ["peanut"], "resolve"),
    ("almonds", ["almond"], [], "resolve"),
    ("walnuts", ["walnut"], [], "resolve"),
    ("cashews", ["cashew"], [], "resolve"),
    ("olive oil", ["olive"], [], "resolve"),
    ("coconut oil", ["coconut"], [], "resolve"),
    ("mayonnaise", ["mayo"], [], "resolve"),
    ("ketchup", ["ketchup"], [], "resolve"),
    ("mustard", ["mustard"], [], "resolve"),
    ("soy sauce", ["soy"], [], "resolve"),
    ("hot sauce", ["sauce"], [], "ambiguous"),
    ("honey", ["honey"], [], "resolve"),
    ("maple syrup", ["maple", "syrup"], [], "resolve"),
    ("hummus", ["hummus"], [], "resolve"),
    ("guacamole", ["guacamole"], [], "resolve"),
    ("salsa", ["salsa"], [], "resolve"),
    ("chia seeds", ["chia"], [], "resolve"),
    ("peanuts", ["peanut"], [], "resolve"),
]

# --- branded ---------------------------------------------------------------
BRANDED = [
    ("quaker oats", ["oat", "quaker"], [], "resolve"),
    ("cheerios", ["cheerio"], [], "resolve"),
    ("coca cola", ["cola"], [], "resolve"),
    ("pepsi", ["pepsi"], [], "resolve"),
    ("oreo", ["oreo"], [], "resolve"),
    ("nutella", ["nutella"], [], "resolve"),
    ("kind bar", ["kind"], [], "ambiguous"),
    ("clif bar", ["clif"], [], "resolve"),
    ("gatorade", ["gatorade"], [], "resolve"),
    ("doritos", ["dorito"], [], "resolve"),
    ("pringles", ["pringle"], [], "resolve"),
    ("ben and jerrys", ["jerry"], [], "ambiguous"),
    ("chobani", ["chobani"], [], "resolve"),
    ("kelloggs corn flakes", ["flake", "corn"], [], "resolve"),
    ("heinz ketchup", ["ketchup", "heinz"], [], "resolve"),
    ("campbells soup", ["soup", "campbell"], [], "resolve"),
    ("lays chips", ["chip", "lay"], [], "ambiguous"),
    ("starbucks coffee", ["coffee", "starbuck"], [], "resolve"),
]

# --- misspellings: the safety-critical category ----------------------------
MISSPELLING = [
    ("chiken breast", ["chicken"], ["turkey", "pork", "beef"], "resolve"),
    ("brocoli", ["broccoli"], [], "resolve"),
    ("bannana", ["banana"], [], "resolve"),
    ("yoghurt", ["yog"], [], "resolve"),
    ("avacado", ["avocado"], [], "resolve"),
    ("brocolli", ["broccoli"], [], "resolve"),
    ("tomatoe", ["tomato"], [], "resolve"),
    ("spinnach", ["spinach"], [], "resolve"),
    ("chedar cheese", ["cheddar"], [], "resolve"),
    ("peanutbutter", ["peanut"], [], "resolve"),
    ("salmoon", ["salmon"], ["tuna"], "resolve"),
    ("potatoe", ["potato"], [], "resolve"),
    ("cucumbr", ["cucumber"], [], "resolve"),
    ("strawbery", ["strawberr"], [], "resolve"),
    ("mozarella", ["mozzarella"], [], "resolve"),
    ("cauliflour", ["cauliflower"], [], "resolve"),
    ("asparagas", ["asparagus"], [], "resolve"),
    ("quinao", ["quinoa"], [], "resolve"),
    ("bluberries", ["blueberr"], [], "resolve"),
    ("sandwhich", ["sandwich"], [], "ambiguous"),
    ("brocolli rabe", ["broccoli"], [], "resolve"),
    ("chikpeas", ["chickpea"], [], "resolve"),
    ("lentels", ["lentil"], [], "resolve"),
    ("pinapple", ["pineapple"], [], "resolve"),
    ("zuchini", ["zucchini"], [], "resolve"),
]

# --- abbreviations ----------------------------------------------------------
ABBREV = [
    ("pb", ["peanut"], [], "resolve"),
    ("pb and j", ["peanut"], [], "resolve"),
    ("og chicken", ["chicken"], ["turkey"], "resolve"),
    ("bbq sauce", ["barbecue", "sauce"], [], "resolve"),
    ("choc milk", ["chocolate", "milk"], [], "resolve"),
    ("ww bread", ["wheat", "bread"], [], "resolve"),
    ("veg soup", ["vegetable", "soup"], [], "resolve"),
    ("gf bread", ["gluten", "bread"], [], "resolve"),
    ("evoo", ["olive"], [], "resolve"),
    ("choc chip cookie", ["chocolate", "cookie"], [], "resolve"),
    ("veg stir fry", ["vegetable"], [], "ambiguous"),
]

# --- plurals / morphology ---------------------------------------------------
MORPHOLOGY = [
    ("bananas", ["banana"], [], "resolve"),
    ("apples", ["apple"], [], "ambiguous"),
    ("carrots", ["carrot"], [], "resolve"),
    ("tomatoes", ["tomato"], [], "ambiguous"),
    ("potatoes", ["potato"], [], "ambiguous"),
    ("almond", ["almond"], [], "resolve"),
    ("egg", ["egg"], [], "resolve"),
    ("berries", ["berr"], [], "ambiguous"),
    ("cherries", ["cherr"], [], "resolve"),
    ("sandwiches", ["sandwich"], [], "ambiguous"),
]

# --- natural language ---------------------------------------------------------
NATURAL = [
    ("a cup of white rice", ["rice"], [], "resolve"),
    ("two scrambled eggs", ["egg"], [], "resolve"),
    ("some grilled chicken", ["chicken"], ["turkey"], "resolve"),
    ("i had a banana", ["banana"], [], "resolve"),
    ("half an avocado", ["avocado"], [], "resolve"),
    ("a slice of whole wheat bread", ["bread"], [], "resolve"),
    ("bowl of oatmeal", ["oat"], [], "resolve"),
    ("glass of whole milk", ["milk"], [], "resolve"),
    ("add greek yogurt", ["yogurt"], [], "resolve"),
    ("log two eggs", ["egg"], [], "resolve"),
    ("100 grams of chicken", ["chicken"], ["turkey"], "ambiguous"),
    ("a piece of salmon", ["salmon"], ["tuna"], "resolve"),
]

# --- preparation ----------------------------------------------------------
PREPARATION = [
    ("raw broccoli", ["broccoli"], [], "resolve"),
    ("steamed broccoli", ["broccoli"], [], "resolve"),
    ("boiled potato", ["potato"], [], "resolve"),
    ("fried egg", ["egg"], [], "resolve"),
    ("roasted vegetables", ["vegetable"], [], "ambiguous"),
    ("baked salmon", ["salmon"], ["tuna"], "resolve"),
    ("raw spinach", ["spinach"], [], "resolve"),
    ("cooked quinoa", ["quinoa"], [], "resolve"),
    ("dried apricots", ["apricot"], [], "resolve"),
    ("frozen berries", ["berr"], [], "ambiguous"),
    ("canned beans", ["bean"], [], "ambiguous"),
    ("smoked salmon", ["salmon"], ["tuna"], "resolve"),
]

# --- cuisine ---------------------------------------------------------------
CUISINE = [
    ("sushi", ["sushi"], [], "ambiguous"),
    ("pad thai", ["thai", "pad"], [], "resolve"),
    ("burrito", ["burrito"], [], "ambiguous"),
    ("taco", ["taco"], [], "ambiguous"),
    ("pizza", ["pizza"], [], "ambiguous"),
    ("lasagna", ["lasagna"], [], "resolve"),
    ("falafel", ["falafel"], [], "resolve"),
    ("naan", ["naan"], [], "resolve"),
    ("kimchi", ["kimchi"], [], "resolve"),
    ("miso soup", ["miso"], [], "resolve"),
    ("ramen", ["ramen"], [], "ambiguous"),
    ("curry", ["curry"], [], "ambiguous"),
    ("paella", ["paella"], [], "resolve"),
    ("gyro", ["gyro"], [], "resolve"),
    ("pho", ["pho"], [], "resolve"),
    ("empanada", ["empanada"], [], "resolve"),
    ("dumplings", ["dumpling"], [], "resolve"),
    ("couscous salad", ["couscous"], [], "resolve"),
]

# --- intentionally ambiguous ------------------------------------------------
AMBIGUOUS = [
    ("chicken", ["chicken"], ["turkey"], "ambiguous"),
    ("cheese", ["cheese"], [], "ambiguous"),
    ("bar", ["bar"], [], "ambiguous"),
    ("juice", ["juice"], [], "ambiguous"),
    ("soup", ["soup"], [], "ambiguous"),
    ("salad", ["salad"], [], "ambiguous"),
    ("smoothie", ["smoothie"], [], "ambiguous"),
    ("shake", ["shake"], [], "ambiguous"),
    ("wrap", ["wrap"], [], "ambiguous"),
    ("sandwich", ["sandwich"], [], "ambiguous"),
    ("water", ["water"], [], "ambiguous"),
    ("coffee", ["coffee"], [], "ambiguous"),
    ("tea", ["tea"], [], "ambiguous"),
    ("beans", ["bean"], [], "ambiguous"),
    ("nuts", ["nut"], [], "ambiguous"),
    ("crackers", ["cracker"], [], "ambiguous"),
]

# --- intentionally absent ---------------------------------------------------
ABSENT = [
    ("xyzzy", [], [], "absent"),
    ("qwertyfood", [], [], "absent"),
    ("asdfghjkl", [], [], "absent"),
    ("zzzzzzzz", [], [], "absent"),
    ("flurbleberry", [], [], "absent"),
    ("nonexistentfood", [], [], "absent"),
    ("blorptato", [], [], "absent"),
    ("grumbleflax", [], [], "absent"),
]

CATEGORIES = {
    "protein": PROTEIN, "grain": GRAIN, "dairy": DAIRY, "produce": PRODUCE,
    "fats_condiments": FATS, "branded": BRANDED, "misspelling": MISSPELLING,
    "abbreviation": ABBREV, "morphology": MORPHOLOGY,
    "natural_language": NATURAL, "preparation": PREPARATION,
    "cuisine": CUISINE, "ambiguous": AMBIGUOUS, "absent": ABSENT,
}


def corpus():
    out = []
    for category, entries in CATEGORIES.items():
        for query, required, forbidden, expectation in entries:
            out.append({
                "query": query, "category": category,
                "requiredAny": required, "forbidden": forbidden,
                "expectation": expectation,
            })
    return out


if __name__ == "__main__":
    c = corpus()
    print(f"{len(c)} queries across {len(CATEGORIES)} categories")
    for k, v in CATEGORIES.items():
        print(f"  {k:18} {len(v)}")
