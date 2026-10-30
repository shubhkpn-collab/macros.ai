import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {validGroceryProduct,type GroceryProduct,type GroceryImage} from '../packages/catalog-runtime/src/grocery-products.js';
export interface BrandedLookup {
 search(query:string):readonly GroceryProduct[];
 photo(barcode:string):GroceryImage|null|undefined;
 savePhoto(barcode:string,image:GroceryImage|null):void;
}
/** Backend-only disk catalog. The tablet receives at most sixteen immutable food versions. */
export class BrandedLibrary implements BrandedLookup {
 private foods:DatabaseSync;
 private images:DatabaseSync;
 constructor(path:string,photoPath:string){
  this.foods=new DatabaseSync(path,{readOnly:true});
  this.images=new DatabaseSync(photoPath);
  this.images.exec('PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS photos (barcode TEXT PRIMARY KEY, image TEXT, checked INTEGER NOT NULL)');
 }
 search(query:string):readonly GroceryProduct[]{
  const words=query.match(/[\p{L}\p{N}]+/gu)??[];if(!words.length||words.length>20)return [];
  // Tokenized and quoted, never raw FTS syntax or SQL from user speech.
  const match=words.map(w=>`"${w}"`).join(' AND ');
  const rows=this.foods.prepare('SELECT p.body FROM search JOIN products p ON p.rowid=search.rowid WHERE search MATCH ? ORDER BY length(p.name), bm25(search), p.published DESC, p.source_id DESC LIMIT 16').all(match);
  return rows.flatMap(row=>{try{const p:unknown=JSON.parse(String(row.body));return validGroceryProduct(p)?[p]:[];}catch{return [];}});
 }
 photo(barcode:string):GroceryImage|null|undefined{
  const row=this.images.prepare('SELECT image,checked FROM photos WHERE barcode=?').get(barcode.padStart(14,'0'));
  if(!row||Date.now()-Number(row.checked)>(row.image?30:1)*86400000)return undefined;
  try{return row.image?JSON.parse(String(row.image)) as GroceryImage:null;}catch{return undefined;}
 }
 savePhoto(barcode:string,image:GroceryImage|null):void{
  this.images.prepare('INSERT OR REPLACE INTO photos VALUES (?,?,?)').run(barcode.padStart(14,'0'),image?JSON.stringify(image):null,Date.now());
 }
 close():void{this.foods.close();this.images.close();}
}
let instance:BrandedLibrary|undefined;
export function localBrandedLibrary():BrandedLibrary|null{
 if(instance)return instance;
 const path=new URL('../data/runtime/branded-foods.sqlite',import.meta.url);
 if(!existsSync(path))return null;
 try{instance=new BrandedLibrary(path.pathname,new URL('../data/runtime/branded-photos.sqlite',import.meta.url).pathname);return instance;}catch{return null;}
}
