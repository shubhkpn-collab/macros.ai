import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MASTER_KNOWLEDGE,synchronizeKitchenKnowledge,type KnowledgeSnapshot} from '@macros/tablet-voice';
const snapshot=(revision:number)=>({...MASTER_KNOWLEDGE,revision});
test('new authenticated-host snapshot applies and stores for next offline session',async()=>{
 const applied:KnowledgeSnapshot[]=[];let saved='';
 await synchronizeKitchenKnowledge({read:async()=>null,download:async()=>snapshot(5),write:async text=>{saved=text;},apply:value=>applied.push(value as KnowledgeSnapshot),current:()=>true});
 assert.deepEqual(applied.map(p=>p.revision),[4,5]);assert.equal(JSON.parse(saved).revision,5);
 const offline:KnowledgeSnapshot[]=[];
 await synchronizeKitchenKnowledge({read:async()=>saved,download:async()=>{throw new Error('offline');},write:async()=>{throw new Error('unexpected');},apply:value=>offline.push(value as KnowledgeSnapshot),current:()=>true});
 assert.deepEqual(offline.map(p=>p.revision),[5]);
});
test('broken cache, corrupt network update and server rollback retain good bundled/cache data',async()=>{
 for(const [cached,remote,expected] of [['broken',{passages:[]},4],[JSON.stringify(snapshot(5)),snapshot(4),5]] as const){
  const versions:number[]=[];let writes=0;
  await synchronizeKitchenKnowledge({read:async()=>cached,download:async()=>remote,write:async()=>{writes++;},apply:value=>versions.push((value as KnowledgeSnapshot).revision),current:()=>true});
  assert.deepEqual(versions,[expected]);assert.equal(writes,0);
 }
});
test('ending a conversation while download waits blocks late apply and persistence',async()=>{
 let live=true;let applies=0;let writes=0;
 await synchronizeKitchenKnowledge({read:async()=>null,download:async()=>{live=false;return snapshot(5);},write:async()=>{writes++;},apply:()=>{applies++;},current:()=>live});
 assert.equal(applies,1);assert.equal(writes,0);
});
test('storage failure does not discard a valid active update',async()=>{
 const versions:number[]=[];
 await synchronizeKitchenKnowledge({read:async()=>null,download:async()=>snapshot(5),write:async()=>{throw new Error('disk full');},apply:value=>versions.push((value as KnowledgeSnapshot).revision),current:()=>true});
 assert.deepEqual(versions,[4,5]);
});
