import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KITCHEN_LIBRARY} from '../packages/catalog-runtime/src/kitchen-library.generated.js';
import {readFileSync} from 'node:fs';

test('bundled ingredient facts exactly preserve the source seed and provenance',()=>{
 const source=JSON.parse(readFileSync('data/usda-seed.json','utf8'));
 const byId=new Map(source.map((r:any)=>[r.productId,r]));
 assert.equal(KITCHEN_LIBRARY.length,6877);
 assert.equal(new Set(KITCHEN_LIBRARY.map(p=>p.productVersionId)).size,KITCHEN_LIBRARY.length);
 for(const p of KITCHEN_LIBRARY){
  const row:any=byId.get(p.productId);assert.ok(row);
  assert.equal(p.basis.kcal,row.per100g.energy_kcal.amount);
  assert.equal(p.basis.proteinG,row.per100g.protein.amount);
  assert.equal(p.basis.carbohydrateG,row.per100g.carbohydrate.amount);
  assert.equal(p.basis.fatG,row.per100g.fat.amount);
  assert.equal(p.preparationState,row.preparationState);
  assert.equal(p.source.sourceId,row.externalIdentity.sourceRecordId);
  assert.equal(p.source.sourceFileHash,row.externalIdentity.archiveSha256);
  assert.equal(p.source.verificationStatus,'auto_validated');
 }
});
test('common kitchen ingredients and distinct raw/cooked bases exist without fabricated photos',()=>{
 for(const query of ['oats','tomatoes','rice','chicken','milk','tofu','lentils','salmon','potatoes','banana'])
  assert.ok(KITCHEN_LIBRARY.some(p=>p.displayName.toLowerCase().includes(query)),query);
 for(const query of ['rice','chicken'])for(const preparation of ['raw','cooked'])
  assert.ok(KITCHEN_LIBRARY.some(p=>p.displayName.toLowerCase().includes(query)&&p.preparationState===preparation),`${query} ${preparation}`);
 assert.ok(KITCHEN_LIBRARY.every(p=>!('image' in p)&&!p.brandName));
});
