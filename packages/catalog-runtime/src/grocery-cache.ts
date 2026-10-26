import type {ProductVersion,ProductCatalogHead} from '@macros/contracts';
import {validGroceryProduct,type GroceryProduct,type GroceryImage} from './grocery-products.js';
export interface GroceryFallback {
 getVersion(id:string):Promise<ProductVersion|null>;
 getHead(id:string):Promise<ProductCatalogHead|null>;
 getCurrentVersion(id:string):Promise<ProductVersion|null>;
 listSearchable():Promise<readonly ProductVersion[]>;
}
export interface GroceryCachePorts {
 read():Promise<string|null>;
 write(value:string):Promise<void>;
 download(query:string):Promise<unknown>;
}
/** IO is injected. Only durable immutable versions can become new search choices. */
export class GroceryCache implements GroceryFallback {
 private readonly products=new Map<string,GroceryProduct>();
 private readonly heads=new Map<string,string>();
 private readonly durable=new Set<string>();
 private save:Promise<unknown>=Promise.resolve();
 constructor(private fallback:GroceryFallback,private ports:GroceryCachePorts){}
 async open():Promise<void>{
  try{const text=await this.ports.read();if(!text||text.length>=8000000)return;const rows:unknown=JSON.parse(text);
   if(!Array.isArray(rows)||rows.length>2000)return;
   for(const row of rows)if(validGroceryProduct(row)){this.remember(row);this.durable.add(row.version.productVersionId);}
  }catch{/* A corrupt cache never prevents the bundled catalog from opening. */}
 }
 private remember(p:GroceryProduct):void{
  const existing=this.products.get(p.version.productVersionId);
  if(existing){if(JSON.stringify(existing.version)===JSON.stringify(p.version)&&p.image)this.products.set(p.version.productVersionId,{...existing,image:p.image});return;}
  if(this.products.size>=2000)return;
  this.products.set(p.version.productVersionId,p);this.heads.set(p.version.productId,p.version.productVersionId);
 }
 name(id:string):string|null{return this.products.get(id)?.version.displayName??null;}
 images():Readonly<Record<string,GroceryImage>>{return Object.fromEntries([...this.products].flatMap(([id,p])=>p.image?[[id,p.image]]:[]));}
 async getVersion(id:string):Promise<ProductVersion|null>{return this.products.get(id)?.version??this.fallback.getVersion(id);}
 async getHead(id:string):Promise<ProductCatalogHead|null>{const version=this.heads.get(id);return version?{productId:id,currentProductVersionId:version,isActive:true,updatedAt:this.products.get(version)!.version.effectiveFrom}:this.fallback.getHead(id);}
 async getCurrentVersion(id:string):Promise<ProductVersion|null>{const version=this.heads.get(id);return version?this.getVersion(version):this.fallback.getCurrentVersion(id);}
 async listSearchable():Promise<readonly ProductVersion[]>{return [...await this.fallback.listSearchable(),...[...this.heads.values()].filter(id=>this.durable.has(id)).map(id=>this.products.get(id)!.version)];}
 async searchCandidates(query:string):Promise<readonly ProductVersion[]>{
  if(query.trim().length<2||query.length>100)return this.listSearchable();
  try{
   const body=await this.ports.download(query);
   if(!body||typeof body!=='object'||!('products' in body)||!Array.isArray(body.products)||body.products.length>40)return this.listSearchable();
   const rows=body.products.filter(validGroceryProduct);for(const p of rows)this.remember(p);
   this.save=this.save.catch(()=>undefined).then(async()=>{
    const snapshot=[...this.products.values()];await this.ports.write(JSON.stringify(snapshot));
    for(const p of snapshot)this.durable.add(p.version.productVersionId);
   });
   await this.save.catch(()=>undefined);
   return [...await this.fallback.listSearchable(),...rows.filter(p=>this.durable.has(p.version.productVersionId)).map(p=>this.products.get(p.version.productVersionId)!.version)];
  }catch{return this.listSearchable();}
 }
}
