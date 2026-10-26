import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeFdcGrocery,openFoodFactsImage,validGroceryProduct,type GroceryProduct} from '../packages/catalog-runtime/src/grocery-products.js';
const cache=new Map<string,{until:number;products:readonly GroceryProduct[]}>();
const photos=new Map<string,GroceryProduct['image']>();
const seed=(JSON.parse(readFileSync(new URL('../data/grocery-preview-seed.json',import.meta.url),'utf8')) as {products:unknown[]}).products.filter(validGroceryProduct);
/** Preview lookup, not a retailer inventory feed. Requests remain behind the Mac backend. */
export async function searchGroceries(query:string,key:string,fetchImpl:typeof fetch=fetch):Promise<readonly GroceryProduct[]>{
 const clean=query.trim();if(clean.length<2||clean.length>100)return [];
 const cached=cache.get(clean.toLowerCase());if(cached&&cached.until>Date.now())return cached.products;
 const brand=clean.match(/great value|kirkland(?: signature)?|trader joe['’]?s|signature select|365(?: everyday value)?/i)?.[0];
 const foodText=brand?clean.replace(brand,''):clean;
 const words=foodText.match(/[a-zA-Z0-9]+/g)??[];
 const brandWords=brand?.match(/[a-zA-Z0-9]+/g)??[];
 const matches=(p:GroceryProduct)=>[...words,...brandWords].every(word=>`${p.version.displayName} ${p.version.brandName??''}`.toLowerCase().includes(word.toLowerCase()));
 const fallback=seed.filter(matches).slice(0,16);
 const apiQuery=[...(brand?[`+brandName:"${brand.replace(/["\\]/g,'')}"`]:[]),...words.map(w=>`+description:${w}`)].join(' ');
 const endpoint=new URL('https://api.nal.usda.gov/fdc/v1/foods/search');endpoint.searchParams.set('api_key',key||'DEMO_KEY');
 let response:Response;
 try{response=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:apiQuery,dataType:['Branded'],pageSize:40}),signal:AbortSignal.timeout(10000)});}
 catch{if(fallback.length)return fallback;throw new Error('Grocery data source unavailable');}
 if(!response.ok){if(fallback.length)return fallback;throw new Error('Grocery data source unavailable');}
 const text=await response.text();if(text.length>2000000)throw new Error('Grocery response exceeds limit');
 const raw=JSON.parse(text) as {foods?:unknown[]};
 const products=(Array.isArray(raw.foods)?raw.foods:[]).flatMap(row=>{const hash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(row as Record<string,unknown>).filter(([key])=>!['score','allHighlightFields','foodSearchCriteria'].includes(key))))).digest('hex').slice(0,24);const p=normalizeFdcGrocery(row,hash);return p&&matches(p)?[p]:[];}).slice(0,16);
 // Photos are optional; lack of a verified exact-barcode photo never substitutes another product's picture.
 await Promise.all(products.slice(0,4).map(async p=>{
  if(!photos.has(p.barcode)){
   try{const r=await fetchImpl(`https://world.openfoodfacts.org/api/v2/product/${p.barcode}?fields=code,image_front_url`,{headers:{'user-agent':'MACROS.AI kitchen prototype/0.1 (local development)'},signal:AbortSignal.timeout(2500)});photos.set(p.barcode,r.ok?openFoodFactsImage(await r.json(),p.barcode):null);}catch{photos.set(p.barcode,null);}
  }
 }));
 const output=products.map(p=>({...p,image:photos.get(p.barcode)??null}));
 if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(clean.toLowerCase(),{until:Date.now()+86400000,products:output});return output;
}
