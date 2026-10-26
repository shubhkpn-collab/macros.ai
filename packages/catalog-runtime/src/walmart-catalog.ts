import {normalizeGtin} from '../../catalog-ingestion/src/gtin.js';
import type {GroceryProduct} from './grocery-products.js';
/** Normalized export contract, not a claim that a Walmart connection is configured. */
export interface WalmartListing {
 readonly itemId:string;
 readonly gtin:string;
 readonly name:string;
 readonly productUrl:string;
 readonly status:'published'|'unpublished';
}
export interface WalmartCatalogSnapshot {
 readonly schemaVersion:1;
 readonly market:'US';
 readonly scope:'national_online';
 readonly capturedAt:string;
 readonly sourceReference:string;
 readonly listings:readonly WalmartListing[];
}
export interface WalmartGroceryMatch {
 readonly product:GroceryProduct;
 readonly listing:WalmartListing;
 readonly catalogCapturedAt:string;
 readonly availability:'listed_online_not_local_stock';
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Schema validation does not establish permission to use a feed. Source access is a separate prerequisite. */
export function validateWalmartSnapshot(raw:unknown):raw is WalmartCatalogSnapshot {
 if(!record(raw)||raw.schemaVersion!==1||raw.market!=='US'||raw.scope!=='national_online'||typeof raw.capturedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(raw.capturedAt)||!Number.isFinite(Date.parse(raw.capturedAt))||typeof raw.sourceReference!=='string'||!raw.sourceReference.trim()||!Array.isArray(raw.listings)||raw.listings.length>2000000)return false;
 const ids=new Set<string>();
 for(const listing of raw.listings){
  if(!record(listing)||typeof listing.itemId!=='string'||!/^\d{1,30}$/.test(listing.itemId)||ids.has(listing.itemId)||typeof listing.gtin!=='string'||!normalizeGtin(listing.gtin).ok||typeof listing.name!=='string'||!listing.name.trim()||listing.name.length>500||!['published','unpublished'].includes(String(listing.status))||typeof listing.productUrl!=='string')return false;
  const url=/^https:\/\/www\.walmart\.com\/ip\/(?:[^/?#]+\/)?(\d{1,30})$/.exec(listing.productUrl);
  if(url?.[1]!==listing.itemId)return false;
  ids.add(listing.itemId);
 }
 return true;
}
/** Match by valid exact GTIN only. Brand/name similarity cannot prove a retailer listing. */
export function matchWalmartGroceries(snapshot:WalmartCatalogSnapshot,products:readonly GroceryProduct[]):{matches:readonly WalmartGroceryMatch[];unmatched:number;ambiguous:number}{
 if(!validateWalmartSnapshot(snapshot))throw new Error('Invalid Walmart catalog snapshot');
 const byBarcode=new Map<string,WalmartListing[]>();
 for(const listing of snapshot.listings){if(listing.status!=='published')continue;const code=normalizeGtin(listing.gtin);if(!code.ok)continue;byBarcode.set(code.gtin14,[...byBarcode.get(code.gtin14)??[],listing]);}
 const matches:WalmartGroceryMatch[]=[];let unmatched=0,ambiguous=0;
 for(const product of products){const code=normalizeGtin(product.barcode);const listings=code.ok?byBarcode.get(code.gtin14)??[]:[];
  if(listings.length===0){unmatched++;continue;}if(listings.length!==1){ambiguous++;continue;}
  matches.push({product,listing:listings[0]!,catalogCapturedAt:snapshot.capturedAt,availability:'listed_online_not_local_stock'});
 }
 return {matches,unmatched,ambiguous};
}
