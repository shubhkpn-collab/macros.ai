import type {ProductVersion,ProductCatalogHead} from '@macros/contracts';
import type {GroceryFallback} from './grocery-cache.js';
import {OVERNIGHT_DEMO} from './overnight-demo.generated.js';
export {OVERNIGHT_DEMO};
export function mealPrepGroup(query:string):string|null{
 const q=query.toLowerCase();
 if(/peanut\s*butter|\bjif\b|\bskippy\b/.test(q))return 'peanut butter';
 if(/blueberr/.test(q))return 'blueberries';if(/strawberr/.test(q))return 'strawberries';
 if(/protein|whey|dymatize|body fortress|optimum nutrition/.test(q))return 'protein powder';
 if(/chocolate|lindt|ghirardelli|hershey/.test(q))return 'dark chocolate';
 if(/milk|almondmilk|oatmilk/.test(q))return 'milk';
 if(/oats|oatmeal|quaker/.test(q))return 'oats';return null;
}
/** Only the explicitly started demo narrows search to its curated variant sets. */
export class MealPrepCatalog implements GroceryFallback {
 constructor(private fallback:GroceryFallback&{searchCandidates?(q:string):Promise<readonly ProductVersion[]>},private enabled:()=>boolean){}
 async getVersion(id:string){return OVERNIGHT_DEMO.find(p=>p.version.productVersionId===id)?.version??this.fallback.getVersion(id);}
 async getHead(id:string):Promise<ProductCatalogHead|null>{const p=OVERNIGHT_DEMO.find(p=>p.version.productId===id)?.version;return p?{productId:id,currentProductVersionId:p.productVersionId,isActive:true,updatedAt:p.effectiveFrom}:this.fallback.getHead(id);}
 async getCurrentVersion(id:string){const p=OVERNIGHT_DEMO.find(p=>p.version.productId===id);return p?.version??this.fallback.getCurrentVersion(id);}
 async listSearchable(){return [...await this.fallback.listSearchable(),...OVERNIGHT_DEMO.map(p=>p.version)];}
 offeredCandidates(q:string){const group=this.enabled()?mealPrepGroup(q):null;return group?OVERNIGHT_DEMO.filter(p=>p.group===group).map(p=>p.version):null;}
 async searchCandidates(q:string){const group=this.enabled()?mealPrepGroup(q):null;return group?OVERNIGHT_DEMO.filter(p=>p.group===group).map(p=>p.version):(this.fallback.searchCandidates?.(q)??this.fallback.listSearchable());}
}
