import {KitchenKnowledgeLibrary,validateKnowledgeSnapshot} from './knowledge-library.js';
/** Transport/storage ports let offline behavior be tested without Android or a paid provider. */
export interface KnowledgeSyncPorts {
 read():Promise<string|null>;
 write(value:string):Promise<void>;
 download():Promise<unknown>;
 apply(value:unknown):void;
 current():boolean;
}
export async function synchronizeKitchenKnowledge(ports:KnowledgeSyncPorts):Promise<void>{
 const library=new KitchenKnowledgeLibrary();
 try{const saved=await ports.read();if(saved&&saved.length<=450_000)library.accept(JSON.parse(saved));}catch{/* Retain bundled corpus. */}
 if(!ports.current())return;
 ports.apply(library.current());
 try{
  const raw=await ports.download();if(!ports.current())return;
  const snapshot=validateKnowledgeSnapshot(raw);if(!snapshot)return;
  if(!library.accept(snapshot))return;
  ports.apply(library.current());
  await ports.write(JSON.stringify(library.current()));
 }catch{/* Last valid corpus stays active even if network or persistence fails. */}
}
