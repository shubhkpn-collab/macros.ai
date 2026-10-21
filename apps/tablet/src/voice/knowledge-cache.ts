import AsyncStorage from '@react-native-async-storage/async-storage';
import {synchronizeKitchenKnowledge} from '@macros/tablet-voice';
const KEY='macros.nutrition-knowledge.v1';
/** Local preview transport only. Production must use its authenticated HTTPS host. */
export async function syncKitchenKnowledge(token:string,apply:(snapshot:unknown)=>void,current:()=>boolean):Promise<void>{
 await synchronizeKitchenKnowledge({
  read:()=>AsyncStorage.getItem(KEY),write:value=>AsyncStorage.setItem(KEY,value),apply,current,
  download:async()=>{
   const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),2500);
   try{
    const response=await fetch('http://127.0.0.1:8791/knowledge/nutrition',{headers:{authorization:`Bearer ${token}`},signal:abort.signal});
    if(!response.ok)throw new Error('Knowledge update unavailable');
    const body=await response.text();if(body.length>450_000)throw new Error('Knowledge snapshot exceeds limit');
    return JSON.parse(body) as unknown;
   }finally{clearTimeout(timeout);}
  },
 });
}
