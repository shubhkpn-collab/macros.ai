import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';
import type {ProductVersionRepository} from '@macros/persistence';
import {GroceryCache} from '../../../packages/catalog-runtime/src/grocery-cache.js';
const KEY='macros.preview.grocery-products.v1';
/** Local preview transport. No vendor key reaches Android and no OpenAI call is involved. */
export class GroceryCatalog extends GroceryCache {
 constructor(fallback:ProductVersionRepository){super(fallback,{
  read:()=>AsyncStorage.getItem(KEY),write:value=>AsyncStorage.setItem(KEY,value),
  download:async(query:string)=>{
   const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),15000);
   try{
    const native=NativeModules.MacrosSpeech as {getKitchenToken?():Promise<string|null>}|undefined;
    const token=await native?.getKitchenToken?.();if(!token)throw new Error('Preview backend is not connected');
    const response=await fetch(`http://127.0.0.1:8791/grocery/search?q=${encodeURIComponent(query)}`,{headers:{authorization:`Bearer ${token}`},signal:abort.signal});
    if(!response.ok)throw new Error('Grocery source unavailable');
    const text=await response.text();if(text.length>200000)throw new Error('Grocery response exceeds limit');
    return JSON.parse(text) as unknown;
   }finally{clearTimeout(timeout);}
  },
 });}
}
