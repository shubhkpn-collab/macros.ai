/** Full-release disk index. Streams the official USDA archive; never loads it into tablet RAM. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {createReadStream,mkdirSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {normalizeFdcGrocery} from '../packages/catalog-runtime/src/grocery-products.js';
const archive=process.argv[2];
if(!archive)throw Error('Usage: build-branded-library.ts <official USDA branded JSON zip>');
const sourceHash=createHash('sha256');for await(const chunk of createReadStream(archive))sourceHash.update(chunk);
const archiveSha256=sourceHash.digest('hex');
mkdirSync('data/runtime',{recursive:true});
const stage='data/runtime/branded-foods.build.sqlite';if(existsSync(stage))unlinkSync(stage);
const db=new DatabaseSync(stage);db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE products (barcode TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, published TEXT NOT NULL, source_id INTEGER NOT NULL, body TEXT NOT NULL);');
const insert=db.prepare(`INSERT INTO products VALUES (?,?,?,?,?,?) ON CONFLICT(barcode) DO UPDATE SET name=excluded.name,brand=excluded.brand,published=excluded.published,source_id=excluded.source_id,body=excluded.body WHERE excluded.published>products.published OR (excluded.published=products.published AND excluded.source_id>products.source_id)`);
const child=spawn('unzip',['-p',archive],{stdio:['ignore','pipe','inherit']});
const exited=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
let read=0,accepted=0,rejected=0,malformed=0;
db.exec('BEGIN');
try{
 for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
  const clean=line.trim().replace(/,$/,'');if(!clean.startsWith('{"foodClass"'))continue;
  read++;
  let raw:any;try{raw=JSON.parse(clean);}catch{
   // The archive closes its outer array/object on the last food's line.
   try{if(!clean.endsWith(']}'))throw Error('Malformed row');raw=JSON.parse(clean.slice(0,-2));}catch{malformed++;continue;}
  }
  // Bulk and API responses use different nutrient envelopes. Preserve values and declared units.
  const row={...raw,dataType:'Branded',publishedDate:raw.publicationDate?new Date(raw.publicationDate).toISOString().slice(0,10):undefined,foodNutrients:(raw.foodNutrients??[]).map((n:any)=>({nutrientId:n.nutrient?.id,unitName:String(n.nutrient?.unitName??'').toUpperCase(),value:n.amount}))};
  const hash=createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0,24);
  const normalized=normalizeFdcGrocery(row,hash);if(!normalized){rejected++;continue;}
  const p={...normalized,version:{...normalized.version,source:{...normalized.version.source,releaseId:archive.split('/').pop(),sourceFileHash:archiveSha256}}};
  accepted++;
  insert.run(p.barcode.padStart(14,'0'),p.version.displayName,p.version.brandName??'',p.version.effectiveFrom,raw.fdcId,JSON.stringify(p));
  if(read%10000===0){db.exec('COMMIT; BEGIN');if(read%100000===0)console.log(JSON.stringify({read,accepted,rejected}));}
 }
 if(await exited!==0)throw Error('USDA archive extraction failed');
 if(read===0||accepted===0||malformed)throw Error(`Empty or malformed USDA release: read=${read}, accepted=${accepted}, malformed=${malformed}`);
 db.exec('COMMIT; CREATE VIRTUAL TABLE search USING fts5(name,brand,content=products,content_rowid=rowid); INSERT INTO search(search) VALUES (\'rebuild\');');
 const count=Number((db.prepare('SELECT count(*) AS count FROM products').get() as any).count);
 const brands=Number((db.prepare('SELECT count(DISTINCT brand) AS count FROM products WHERE brand<>\'\'').get() as any).count);
 const report={release:'USDA October 2026',archive:archive.split('/').pop(),archiveSha256,recordsRead:read,acceptedRecords:accepted,rejectedRecords:rejected,malformed,uniqueBarcodes:count,brands,photoCoverage:'Measured separately; package photos are not part of USDA',scope:'US market, active, valid GTIN, gram-based servings and complete plausible macros',duplicatePolicy:'For identical GTIN keep newest publication, then highest source id; no name-based merge',inventoryVerified:false};
 db.exec('PRAGMA integrity_check');db.close();renameSync(stage,'data/runtime/branded-foods.sqlite');
 writeFileSync('data/grocery/branded-library-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){child.kill();db.close();throw error;}
