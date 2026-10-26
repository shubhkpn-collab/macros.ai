import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWalmartSnapshot,matchWalmartGroceries,type WalmartCatalogSnapshot} from '../packages/catalog-runtime/src/walmart-catalog.js';
import type {GroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';
const products=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8')).products as GroceryProduct[];
// Synthetic listing fixtures exercise the schema; these are NOT actual Walmart listings.
const snapshot=():WalmartCatalogSnapshot=>({schemaVersion:1,market:'US',scope:'national_online',capturedAt:'2026-10-25T12:00:00Z',sourceReference:'synthetic test only',listings:[{itemId:'123456',gtin:products[0]!.barcode,name:'Synthetic listing',productUrl:'https://www.walmart.com/ip/test-item/123456',status:'published'}]});
test('Walmart scope is US national listings, with exact valid barcode matching',()=>{
 const s=snapshot();assert.ok(validateWalmartSnapshot(s));const result=matchWalmartGroceries(s,[products[0]!]);assert.equal(result.matches.length,1);assert.equal(result.matches[0]?.product.version.productVersionId,products[0]?.version.productVersionId);assert.equal(result.matches[0]?.availability,'listed_online_not_local_stock');
});
test('same brand or name cannot substitute for evidence of Walmart listing',()=>{
 const s=snapshot();const p={...products[0]!,barcode:'076014101088'};const result=matchWalmartGroceries(s,[p]);assert.equal(result.matches.length,0);assert.equal(result.unmatched,1);
});
test('unpublished and ambiguous listing evidence is not offered as a match',()=>{
 const s=snapshot();assert.equal(matchWalmartGroceries({...s,listings:s.listings.map(l=>({...l,status:'unpublished'}))},[products[0]!]).matches.length,0);
 const result=matchWalmartGroceries({...s,listings:[...s.listings,{...s.listings[0]!,itemId:'999999',productUrl:'https://www.walmart.com/ip/999999'}]},[products[0]!]);assert.equal(result.matches.length,0);assert.equal(result.ambiguous,1);
});
test('wrong market, malformed barcode and misleading listing URLs are rejected',()=>{
 const s=snapshot();for(const value of [{...s,market:'CA'},{...s,scope:'local_stock'},{...s,capturedAt:'invalid'},{...s,listings:[{...s.listings[0],gtin:'bad'}]},{...s,listings:[{...s.listings[0],productUrl:'https://www.walmart.com.attacker.example/ip/123456'}]},{...s,listings:[{...s.listings[0],productUrl:'https://www.walmart.com/ip/999999'}]},{...s,listings:[s.listings[0],s.listings[0]]}])assert.equal(validateWalmartSnapshot(value),false);
});
