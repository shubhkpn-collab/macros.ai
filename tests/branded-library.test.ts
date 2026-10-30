import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrandedLibrary} from '../tools/branded-library.js';
import {searchGroceries} from '../tools/grocery-search.js';
import {validGroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';

test('disk catalog search is bounded, literal and preserves authoritative product facts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'macros-brands-'));
 const path=join(dir,'foods.sqlite');const db=new DatabaseSync(path);
 const seed=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8')).products;
 db.exec('CREATE TABLE products (barcode TEXT PRIMARY KEY,name TEXT,brand TEXT,published TEXT,source_id INTEGER,body TEXT); CREATE VIRTUAL TABLE search USING fts5(name,brand,content=products,content_rowid=rowid);');
 for(const [i,p] of seed.entries())db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?)').run(p.barcode,p.version.displayName,p.version.brandName??'',p.version.effectiveFrom,i,JSON.stringify(p));
 db.exec("INSERT INTO search(search) VALUES ('rebuild')");db.close();
 const library=new BrandedLibrary(path,join(dir,'photos.sqlite'));
 try{
  const found=library.search('Great Value peanut butter');assert.ok(found.length);assert.ok(found.length<=16);assert.ok(found.every(validGroceryProduct));
  assert.deepEqual(library.search('" OR * -- unknownunlisted'),[]);
  const product=found[0]!;assert.equal(library.photo(product.barcode),undefined);
  library.savePhoto(product.barcode,null);assert.equal(library.photo(product.barcode),null);
 }finally{library.close();rmSync(dir,{recursive:true,force:true});}
});
test('local branded search avoids USDA API and persists only exact-barcode photos',async()=>{
 const product=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8')).products[0];let calls=0,saved=0;
 const library={search:()=>[product],photo:()=>undefined,savePhoto:()=>{saved++;}};
 const fetchImpl=(async(input:unknown)=>{calls++;assert.ok(String(input).startsWith('https://world.openfoodfacts.org/'));return new Response(JSON.stringify({status:1,product:{code:product.barcode,image_front_url:'https://images.openfoodfacts.org/images/products/123/456/789/0123/front_en.1.400.jpg'}}));}) as typeof fetch;
 const found=await searchGroceries('local catalog exact image test','',fetchImpl,library);
 assert.equal(calls,1);assert.equal(saved,1);assert.ok(found[0]?.image);assert.deepEqual(found[0]?.version,product.version);
});

test('persisted photo metadata supplies every returned card without external requests',async()=>{
 const product=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8')).products.find((p:any)=>p.image);
 const library={search:()=>[product],photo:()=>product.image,savePhoto:()=>{throw Error('Unexpected metadata write');}};
 const fetchImpl=(async()=>{throw Error('Unexpected external request');}) as typeof fetch;
 const found=await searchGroceries('persisted photo full card test','',fetchImpl,library);
 assert.deepEqual(found[0]?.image,product.image);
 assert.ok(found.every(validGroceryProduct));
});
