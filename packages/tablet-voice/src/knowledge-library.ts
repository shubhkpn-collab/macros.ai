import {NUTRITION_CORPUS} from './nutrition-corpus.js';
import {retrieveKitchenKnowledge,PRODUCT_KNOWLEDGE,type KitchenKnowledgePassage} from './kitchen-knowledge.js';

export interface KnowledgeSnapshot {
  readonly schemaVersion:1;
  readonly revision:number;
  readonly passages:readonly KitchenKnowledgePassage[];
}
export const MASTER_KNOWLEDGE:KnowledgeSnapshot={schemaVersion:1,revision:3,passages:NUTRITION_CORPUS};
const hosts=new Set(['www.fda.gov','www.foodsafety.gov','ods.od.nih.gov','www.cdc.gov','www.canada.ca','fdc.nal.usda.gov']);
const record=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string' && v.trim().length>0 && v.length<=max;
/** Reject the entire update on malformed data. Network updates never replace calculation/product rules. */
export function validateKnowledgeSnapshot(raw:unknown):KnowledgeSnapshot|null {
  if(!record(raw)||Object.keys(raw).some(k=>!['schemaVersion','revision','passages'].includes(k))||raw.schemaVersion!==1||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1||!Array.isArray(raw.passages)||raw.passages.length<1||raw.passages.length>250)return null;
  const ids=new Set<string>();const passages:KitchenKnowledgePassage[]=[];
  for(const p of raw.passages){
    if(!record(p)||Object.keys(p).some(k=>!['id','title','source','reviewStatus','publisher','verifiedAt','keywords','text'].includes(k))||p.reviewStatus!=='PUBLIC_SOURCE_SUMMARY'||!text(p.id,80)||!/^[-a-z0-9]+$/.test(p.id)||(ids.has(p.id)||PRODUCT_KNOWLEDGE.some(rule=>rule.id===p.id))||!text(p.title,160)||!text(p.text,1600)||!text(p.publisher,100)||!text(p.source,500)||!text(p.verifiedAt,10)||!/^\d{4}-\d{2}-\d{2}$/.test(p.verifiedAt)||!Array.isArray(p.keywords)||p.keywords.length<1||p.keywords.length>50||p.keywords.some(k=>!text(k,50)))return null;
    // Canonical origin allowlist; no credentials, tracking query, fragments or arbitrary ports.
    const match=/^https:\/\/([^/:?#]+)(\/[^?#]*)$/.exec(p.source);
    if(!match||!hosts.has(match[1]??''))return null;
    const parsedDate=new Date(`${p.verifiedAt}T00:00:00Z`);
    if(!Number.isFinite(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==p.verifiedAt)return null;
    ids.add(p.id);
    passages.push({id:p.id,title:p.title,source:p.source,reviewStatus:'PUBLIC_SOURCE_SUMMARY',publisher:p.publisher,verifiedAt:p.verifiedAt,keywords:[...p.keywords] as string[],text:p.text});
  }
  return {schemaVersion:1,revision:Number(raw.revision),passages};
}
/** Last valid public corpus survives invalid, same-revision or older updates. Built-in rules stay pinned. */
export class KitchenKnowledgeLibrary {
  private snapshot:KnowledgeSnapshot=validateKnowledgeSnapshot(MASTER_KNOWLEDGE)!;
  current():KnowledgeSnapshot {return JSON.parse(JSON.stringify(this.snapshot)) as KnowledgeSnapshot;}
  accept(raw:unknown):boolean {
    const next=validateKnowledgeSnapshot(raw);
    if(!next||next.revision<=this.snapshot.revision)return false;
    this.snapshot=next;return true;
  }
  retrieve(query:string){return {...retrieveKitchenKnowledge(query,this.snapshot.passages),revision:this.snapshot.revision};}
}
