import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';
import type {ProductVersionRepository} from '@macros/persistence';
import type {ProductVersion,ProductCatalogHead} from '@macros/contracts';
import {validGroceryProduct,type GroceryProduct,type GroceryImage} from '../../../packages/catalog-runtime/src/grocery-products.js';
const KEY='macros.preview.grocery-products.v1';
/** Local-preview adapter. Remote food facts are cached by immutable version, independently of OpenAI credit. */
export class GroceryCatalog implements ProductVersionRepository {
 private readonly products=new Map<string,GroceryProduct>();
 private readonly heads=new Map<string,string>();
 private save:Promise<unknown>=Promise.resolve();
 constructor(private fallback:ProductVersionRepository){}
 async open():Promise<void>{try{const text=await AsyncStorage.getItem(KEY);if(text&&text.length<8000000){const rows:unknown=JSON.parse(text);if(Array.isArray(rows)&&rows.length<=2000)for(const row of rows)if(validGroceryProduct(row))this.remember(row);}}catch{/* Bundled demo remains usable. */}}
 private remember(p:GroceryProduct):void{const existing=this.products.get(p.version.productVersionId);if(existing){if(JSON.stringify(existing.version)===JSON.stringify(p.version)&&p.image)this.products.set(p.version.productVersionId,{...existing,image:p.image});return;}if(this.products.size>=2000)return;this.products.set(p.version.productVersionId,p);this.heads.set(p.version.productId,p.version.productVersionId);}
 name(id:string):string|null{return this.products.get(id)?.version.displayName??null;}
 images():Readonly<Record<string,GroceryImage>>{return Object.fromEntries([...this.products].flatMap(([id,p])=>p.image?[[id,p.image]]:[]));}
 async getVersion(id:string):Promise<ProductVersion|null>{return this.products.get(id)?.version??this.fallback.getVersion(id);}
 async getHead(id:string):Promise<ProductCatalogHead|null>{const version=this.heads.get(id);return version?{productId:id,currentProductVersionId:version,isActive:true,updatedAt:this.products.get(version)!.version.effectiveFrom}:this.fallback.getHead(id);}
 async getCurrentVersion(id:string):Promise<ProductVersion|null>{const version=this.heads.get(id);return version?this.getVersion(version):this.fallback.getCurrentVersion(id);}
 async listSearchable():Promise<readonly ProductVersion[]>{return [...await this.fallback.listSearchable(),...[...this.heads.values()].map(id=>this.products.get(id)!.version)];}
 async searchCandidates(query:string):Promise<readonly ProductVersion[]>{
  const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),15000);
  try{
   const native=NativeModules.MacrosSpeech as {getKitchenToken?():Promise<string|null>}|undefined;
   const token=await native?.getKitchenToken?.();if(!token)return this.listSearchable();
   const response=await fetch(`http://127.0.0.1:8791/grocery/search?q=${encodeURIComponent(query)}`,{headers:{authorization:`Bearer ${token}`},signal:abort.signal});
   if(!response.ok)return this.listSearchable();
   const text=await response.text();if(text.length>200000)return this.listSearchable();
   const body=JSON.parse(text) as {products?:unknown};if(!Array.isArray(body.products)||body.products.length>40)return this.listSearchable();
   const rows=body.products.filter(validGroceryProduct);for(const p of rows)this.remember(p);
   this.save=this.save.catch(()=>undefined).then(()=>AsyncStorage.setItem(KEY,JSON.stringify([...this.products.values()])));await this.save.catch(()=>undefined);
   return [...await this.fallback.listSearchable(),...rows.filter(p=>this.products.has(p.version.productVersionId)).map(p=>this.products.get(p.version.productVersionId)!.version)];
  }catch{return this.listSearchable();}finally{clearTimeout(timeout);}
 }
}
