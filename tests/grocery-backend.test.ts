import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchGroceries} from '../tools/grocery-search.js';
test('grocery seed stays testable with source rate limiting or no network, without paid calls',async()=>{
 for(const fetchImpl of [(async()=>new Response('{}',{status:429})) as typeof fetch,(async()=>{throw Error('offline');}) as typeof fetch]){
  const products=await searchGroceries('Great Value peanut butter','',fetchImpl);assert.ok(products.length>0);assert.ok(products.some(p=>p.image));assert.ok(products.every(p=>p.version.source.kind==='usda_branded'));
 }
});
test('unknown products stay unavailable rather than invented during a source outage',async()=>{
 await assert.rejects(searchGroceries('unlisted example test cereal','',async()=>new Response('{}',{status:503})),/unavailable/);
});
test('empty and oversized searches never call a provider',async()=>{
 let calls=0;const fake=(async()=>{calls++;return new Response('{}');}) as typeof fetch;
 assert.deepEqual(await searchGroceries('','',fake),[]);assert.deepEqual(await searchGroceries('a'.repeat(101),'',fake),[]);assert.equal(calls,0);
});
