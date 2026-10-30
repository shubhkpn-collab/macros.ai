import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFdcGrocery,openFoodFactsImage,validGroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';
const row=()=>({fdcId:12345,dataType:'Branded',description:'PEANUT BUTTER',brandName:'Example',marketCountry:'United States',gtinUpc:'078742378213',servingSize:32,servingSizeUnit:'g',publishedDate:'2026-04-30',foodNutrients:[{nutrientId:1008,unitName:'KCAL',value:600},{nutrientId:1003,unitName:'G',value:25},{nutrientId:1005,unitName:'G',value:20},{nutrientId:1004,unitName:'G',value:50}]});
test('FDC grocery facts remain per100g and preserve source and gram serving',()=>{
 const p=normalizeFdcGrocery(row(),'abcdef123456');assert.ok(p);assert.equal(p.version.basis.kcal,600);assert.equal(p.version.labelFacts?.servingGrams,32);assert.equal(p.version.source.kind,'usda_branded');assert.equal(p.version.source.verificationStatus,'auto_validated');assert.ok(validGroceryProduct(p));assert.equal(p.image,null);
});
test('no guessed density, missing macros, bad barcode or impossible food enters the weighable catalog',()=>{
 for(const mutate of [(v:any)=>v.servingSizeUnit='ml',(v:any)=>v.foodNutrients.pop(),(v:any)=>v.foodNutrients[0].unitName='KJ',(v:any)=>v.foodNutrients[1].value=-1,(v:any)=>v.foodNutrients[3].value=Infinity,(v:any)=>v.gtinUpc='078742378214',(v:any)=>v.marketCountry='Unknown',(v:any)=>v.discontinuedDate='2024-01-01']){const v=row();mutate(v);assert.equal(normalizeFdcGrocery(v,'abcdef123456'),null);}
});
test('image requires matching exact barcode and approved image host',()=>{
 const photo={status:1,product:{code:'0078742378213',image_front_url:'https://images.openfoodfacts.org/images/products/007/874/237/8213/front_en.3.400.jpg'}};
 const image=openFoodFactsImage(photo,'078742378213');assert.ok(image);assert.equal(image.license,'CC-BY-SA-3.0');
 assert.equal(openFoodFactsImage(photo,'076014101088'),null);
 assert.equal(openFoodFactsImage({...photo,product:{...photo.product,image_front_url:'https://attacker.example/photo.jpg'}},'078742378213'),null);
 const p=normalizeFdcGrocery(row(),'abcdef123456')!;assert.ok(validGroceryProduct({...p,image}));assert.equal(validGroceryProduct({...p,image:{...image,sourceUrl:'https://attacker.example'}}),false);
});
test('untrusted cache values cannot bypass missing nutrient or volume guards',()=>{
 const p=normalizeFdcGrocery(row(),'abcdef123456')!;
 assert.equal(validGroceryProduct({...p,version:{...p.version,basis:{...p.version.basis,fatG:NaN}}}),false);
 assert.equal(validGroceryProduct({...p,version:{...p.version,basis:{...p.version.basis,kind:'per_100ml'}}}),false);
 assert.equal(validGroceryProduct({...p,version:{...p.version,source:{...p.version.source,kind:'synthetic_test'}}}),false);
});
test('explicit USDA GRM gram unit is accepted without treating millilitres as grams',()=>{
 const raw={...row(),servingSizeUnit:'GRM'};assert.ok(normalizeFdcGrocery(raw,'abcdef123456'));
 assert.equal(normalizeFdcGrocery({...raw,servingSizeUnit:'MLT'},'abcdef123456'),null);
});
