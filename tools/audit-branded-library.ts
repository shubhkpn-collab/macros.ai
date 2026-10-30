/** Audit the entire built index and its photo joins without any network calls. */
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {validGroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';
const foods=new DatabaseSync('data/runtime/branded-foods.sqlite',{readOnly:true});
const photos=new DatabaseSync('data/runtime/branded-photos.sqlite',{readOnly:true});
let products=0,invalidProducts=0,images=0,invalidImages=0,orphanImages=0;
for(const row of foods.prepare('SELECT body FROM products').iterate()){
 products++;try{if(!validGroceryProduct(JSON.parse(String(row.body))))invalidProducts++;}catch{invalidProducts++;}
}
const lookup=foods.prepare('SELECT body FROM products WHERE barcode=?');
for(const row of photos.prepare('SELECT barcode,image FROM photos WHERE image IS NOT NULL').iterate()){
 images++;const food=lookup.get(String(row.barcode));if(!food){orphanImages++;continue;}
 try{if(!validGroceryProduct({...JSON.parse(String(food.body)),image:JSON.parse(String(row.image))}))invalidImages++;}catch{invalidImages++;}
}
const probes=['Quaker oats','Great Value peanut butter','Kirkland almonds','Chobani yogurt','Tyson chicken','Barilla pasta','Bobs Red Mill flour','rice','tofu','bread'];
const search=foods.prepare('SELECT p.barcode,p.name,p.brand FROM search JOIN products p ON p.rowid=search.rowid WHERE search MATCH ? ORDER BY length(p.name),bm25(search),p.published DESC,p.source_id DESC LIMIT 16');
const photo=photos.prepare('SELECT image FROM photos WHERE barcode=?');
const searches=probes.map(query=>{const rows=search.all(query.split(' ').map(w=>`"${w}"`).join(' AND '));return {query,returned:rows.length,withPhotos:rows.filter(r=>photo.get(String(r.barcode))?.image).length,examples:rows.slice(0,4).map(r=>({name:r.name,brand:r.brand,barcode:r.barcode}))};});
const report={products,invalidProducts,photoMetadataRecords:images,invalidImages,orphanImages,searches,networkCalls:0,scope:'Full local index and exact photo-metadata join validation; not manual package review or all-image HTTP validation'};
writeFileSync('data/grocery/branded-library-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({products,invalidProducts,images,invalidImages,orphanImages}));
foods.close();photos.close();if(invalidProducts||invalidImages||orphanImages)process.exitCode=1;
