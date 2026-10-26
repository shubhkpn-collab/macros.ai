import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GroceryCache} from '../packages/catalog-runtime/src/grocery-cache.js';
import type {GroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';
const seed=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8')).products as GroceryProduct[];
const first=seed[0]!;
const fallback={getVersion:async()=>null,getHead:async()=>null,getCurrentVersion:async()=>null,listSearchable:async()=>[]};
test('grocery download, save, process restart and offline selection preserve exact version and photo metadata',async()=>{
 let saved='';const live=new GroceryCache(fallback,{read:async()=>null,write:async text=>{saved=text;},download:async()=>({products:seed})});
 await live.open();assert.equal((await live.searchCandidates('peanut butter')).length,seed.length);
 const offline=new GroceryCache(fallback,{read:async()=>saved,write:async()=>{throw Error('offline');},download:async()=>{throw Error('offline');}});
 await offline.open();assert.deepEqual(await offline.getVersion(first.version.productVersionId),first.version);
 assert.equal((await offline.searchCandidates('peanut butter')).length,seed.length);
 assert.equal(offline.name(first.version.productVersionId),first.version.displayName);
 for(const p of seed)if(p.image)assert.deepEqual(offline.images()[p.version.productVersionId],p.image);
});
test('failed storage cannot offer a newly fetched food; a later successful save recovers',async()=>{
 let writable=false;const cache=new GroceryCache(fallback,{read:async()=>null,write:async()=>{if(!writable)throw Error('disk full');},download:async()=>({products:[first]})});
 assert.deepEqual(await cache.searchCandidates('peanut butter'),[]);assert.deepEqual(await cache.listSearchable(),[]);
 writable=true;assert.equal((await cache.searchCandidates('peanut butter'))[0]?.productVersionId,first.version.productVersionId);
});
test('bad JSON, excessive rows and tampered cache records do not create selectable foods',async()=>{
 for(const text of ['{broken',JSON.stringify({products:seed}),JSON.stringify([{...first,version:{...first.version,basis:{...first.version.basis,kcal:-1}}}]),JSON.stringify(Array(2001).fill(first))]){
  const cache=new GroceryCache(fallback,{read:async()=>text,write:async()=>{},download:async()=>{throw Error('offline');}});await cache.open();assert.deepEqual(await cache.listSearchable(),[]);
 }
});
test('an existing version cannot be rewritten by a conflicting response or lost when the source fails',async()=>{
 let remote:unknown={products:[first]};const cache=new GroceryCache(fallback,{read:async()=>null,write:async()=>{},download:async()=>remote});
 await cache.searchCandidates('peanut butter');remote={products:[{...first,version:{...first.version,basis:{...first.version.basis,kcal:1}}}]};
 const offered=await cache.searchCandidates('peanut butter');assert.equal(offered[0]?.basis.kcal,first.version.basis.kcal);
 remote={products:[]};assert.equal((await cache.getVersion(first.version.productVersionId))?.basis.kcal,first.version.basis.kcal);
});
test('invalid/oversized remote envelopes retain the last saved catalog',async()=>{
 let remote:unknown={products:[first]};const cache=new GroceryCache(fallback,{read:async()=>null,write:async()=>{},download:async()=>remote});await cache.searchCandidates('peanut butter');
 for(const body of [null,{}, {products:'bad'}, {products:Array(41).fill(first)}]){remote=body;assert.equal((await cache.searchCandidates('peanut butter')).length,1);}
});
test('reaching capacity retains historical records and refuses extra products',async()=>{
 const records=Array.from({length:2000},(_,i)=>({...first,version:{...first.version,productId:`fdc-branded-${i+1}`,productVersionId:`fdc-branded-${i+1}@abcdef123456`,source:{...first.version.source,sourceId:String(i+1)}}}));
 const cache=new GroceryCache(fallback,{read:async()=>JSON.stringify(records),write:async()=>{},download:async()=>({products:[first]})});await cache.open();
 assert.equal((await cache.listSearchable()).length,2000);assert.deepEqual(await cache.searchCandidates('peanut butter'),[]);assert.equal((await cache.getVersion(records[0]!.version.productVersionId))?.productId,'fdc-branded-1');
});
