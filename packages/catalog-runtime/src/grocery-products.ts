import {normalizeGtin} from '../../catalog-ingestion/src/gtin.js';
import type {ProductVersion} from '@macros/contracts';
export interface GroceryImage {readonly url:string;readonly sourceUrl:string;readonly attribution:string;readonly license:'CC-BY-SA-3.0'}
export interface GroceryProduct {readonly version:ProductVersion;readonly barcode:string;readonly image:GroceryImage|null}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
/** USDA search rows declare nutrient amounts per 100g. Volume-only products are not made weighable. */
export function normalizeFdcGrocery(raw:unknown,fingerprint:string):GroceryProduct|null {
 if(!object(raw)||raw.dataType!=='Branded'||!Number.isSafeInteger(raw.fdcId)||typeof raw.description!=='string'||!raw.description.trim()||raw.description.length>300||!Array.isArray(raw.foodNutrients)||raw.marketCountry!=='United States'||!['g','GRM','GM'].includes(String(raw.servingSizeUnit))||!finite(raw.servingSize)||raw.servingSize<=0||typeof raw.gtinUpc!=='string'||!normalizeGtin(raw.gtinUpc).ok||!/^[-a-z0-9]{8,80}$/.test(fingerprint))return null;
 if(typeof raw.discontinuedDate==='string'&&raw.discontinuedDate)return null;
 const read=(id:number,unit:string):number|null=>{
  const rows=raw.foodNutrients as unknown[];const hits=rows.filter(v=>object(v)&&v.nutrientId===id);
  if(hits.length!==1)return null;const row=hits[0];
  return object(row)&&row.unitName===unit&&finite(row.value)?row.value:null;
 };
 const kcal=read(1008,'KCAL'),proteinG=read(1003,'G'),carbohydrateG=read(1005,'G'),fatG=read(1004,'G');
 if(kcal===null||proteinG===null||carbohydrateG===null||fatG===null||kcal>1000||[proteinG,carbohydrateG,fatG].some(v=>v>100)||proteinG+carbohydrateG+fatG>105)return null;
 const id=`fdc-branded-${String(raw.fdcId)}`;
 const brand=typeof raw.brandName==='string'&&raw.brandName.trim()?raw.brandName.trim():typeof raw.brandOwner==='string'?raw.brandOwner.trim():'';
 const date=typeof raw.publishedDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.publishedDate)?`${raw.publishedDate}T00:00:00.000Z`:'1970-01-01T00:00:00.000Z';
 return {barcode:raw.gtinUpc,image:null,version:{productId:id,productVersionId:`${id}@${fingerprint}`,versionNo:1,displayName:raw.description.trim(),...(brand?{brandName:brand}:{}),preparationState:'as_sold',basis:{kind:'per_100g',kcal,proteinG,carbohydrateG,fatG},labelFacts:{servingGrams:raw.servingSize,...(typeof raw.householdServingFullText==='string'?{servingLabel:raw.householdServingFullText}:{}),...(typeof raw.ingredients==='string'?{ingredientsText:raw.ingredients}:{})},source:{kind:'usda_branded',sourceId:String(raw.fdcId),verificationStatus:'auto_validated',licenseClass:'public_domain_cc0',releaseId:`fdc-api-${fingerprint}`},effectiveFrom:date as ProductVersion['effectiveFrom']}};
}
/** Image identity must match the exact GTIN, never a name-only visual match. */
export function openFoodFactsImage(raw:unknown,barcode:string):GroceryImage|null {
 if(!object(raw)||raw.status!==1||!object(raw.product))return null;
 const p=raw.product;
 if(typeof p.code!=='string'||p.code.padStart(14,'0')!==barcode.padStart(14,'0')||typeof p.image_front_url!=='string')return null;
 const url=p.image_front_url;
 if(!/^https:\/\/images\.openfoodfacts\.org\/images\/products\/[0-9/]+\/[a-z0-9_.-]+\.jpg$/.test(url))return null;
 return {url,sourceUrl:`https://world.openfoodfacts.org/product/${p.code}`,attribution:'Photo: Open Food Facts contributors',license:'CC-BY-SA-3.0'};
}
/** Validate backend/cache envelopes before any product can enter selection or calculations. */
export function validGroceryProduct(raw:unknown):raw is GroceryProduct {
 if(!object(raw)||!object(raw.version)||typeof raw.barcode!=='string'||!normalizeGtin(raw.barcode).ok)return false;
 const v=raw.version,b=v.basis,s=v.source,l=v.labelFacts;
 if(!object(b)||!object(s)||!object(l)||b.kind!=='per_100g'||!finite(b.kcal)||b.kcal>1000||![b.proteinG,b.carbohydrateG,b.fatG].every(n=>finite(n)&&n<=100)||Number(b.proteinG)+Number(b.carbohydrateG)+Number(b.fatG)>105||!finite(l.servingGrams)||l.servingGrams<=0||typeof v.productId!=='string'||!/^fdc-branded-\d+$/.test(v.productId)||typeof v.productVersionId!=='string'||!new RegExp(`^${v.productId}@[a-f0-9]{8,64}$`).test(v.productVersionId)||v.versionNo!==1||typeof v.displayName!=='string'||!v.displayName.trim()||v.displayName.length>300||v.preparationState!=='as_sold'||s.kind!=='usda_branded'||s.verificationStatus!=='auto_validated'||typeof s.sourceId!=='string'||v.productId!==`fdc-branded-${s.sourceId}`||typeof v.effectiveFrom!=='string'||!Number.isFinite(Date.parse(v.effectiveFrom)))return false;
 if(raw.image===null)return true;
 const i=raw.image;if(!object(i)||i.license!=='CC-BY-SA-3.0'||i.attribution!=='Photo: Open Food Facts contributors'||typeof i.sourceUrl!=='string')return false;
 const code=i.sourceUrl.match(/^https:\/\/world\.openfoodfacts\.org\/product\/(\d{8,14})$/)?.[1];
 return !!code&&openFoodFactsImage({status:1,product:{code,image_front_url:i.url}},raw.barcode)!==null;
}
