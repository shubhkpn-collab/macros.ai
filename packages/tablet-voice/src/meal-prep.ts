export interface MealPrepItem {readonly productVersionId:string;readonly displayName:string;readonly grams:number;readonly kcal:number;readonly proteinG:number;readonly carbohydrateG:number;readonly fatG:number}
/** A session ledger of confirmed ingredients, never an alternative nutrient calculator. */
export class MealPrepSession {
 private active=false;
 private generation:number|null=null;
 private items:MealPrepItem[]=[];
 start(generation:number):void{this.active=true;this.generation=generation;this.items=[];}
 finish():void{this.active=false;}
 enabled():boolean{return this.active;}
 record(item:MealPrepItem,generation:number):void{if(this.active&&this.generation===generation)this.items.push({...item});}
 snapshot(generation:number){
  if(this.generation!==generation)return null;
  return {active:this.active,title:'Overnight oats',items:this.items.map(i=>({...i})),totals:this.items.reduce((sum,i)=>({grams:sum.grams+i.grams,kcal:sum.kcal+i.kcal,proteinG:sum.proteinG+i.proteinG,carbohydrateG:sum.carbohydrateG+i.carbohydrateG,fatG:sum.fatG+i.fatG}),{grams:0,kcal:0,proteinG:0,carbohydrateG:0,fatG:0})};
 }
}
