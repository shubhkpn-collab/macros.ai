import type { TabletViewModel } from '@macros/tablet-view-model';
import type { GuidanceDeps, TabletAppController } from '@macros/tablet-app-core';
import { explicitFoodConfirmation, spokenGrams, KitchenKnowledgeLibrary, spokenFoodOption, type MealPrepSession, spokenNamedFood } from '@macros/tablet-voice';

export interface KitchenActionDeps {
  controller: Pick<TabletAppController, 'searchFood'|'selectProduct'|'enterManualWeight'|'requestStableWeight'|'confirmFoodLog'|'cancelFoodFlow'|'refreshDashboard'|'requestFoodGuidance'|'chooseGuidanceCandidate'|'setBowlBaseline'|'endBowl'|'getBowlState'>;
  state(): TabletViewModel;
  changed(): void;
  mealPrep?:MealPrepSession;
  guidance?: GuidanceDeps;
  now?: () => number;
}
const optionFingerprint=(vm:TabletViewModel):string|null=>['food_options','food_search'].includes(vm.screen)&&vm.options.length>0 ? JSON.stringify([vm.sessionGeneration,vm.flowId,vm.searchQuery,vm.options]) : null;
interface AudioTurn { options:string|null; id: string; fingerprint: string | null; session: number; transcript: string | null; receivedAt: number; consumed: boolean }
export function reviewFingerprint(vm: TabletViewModel): string | null {
  return vm.screen === 'review' && vm.review !== null && vm.selectedFood !== null
    ? JSON.stringify([vm.sessionGeneration, vm.flowId, vm.selectedFood.productVersionId, vm.review]) : null;
}
/** All writes go through the existing controller. Model output is never log authorization. */
export class KitchenActions {
  private knowledge = new KitchenKnowledgeLibrary();
  updateKnowledge(snapshot:unknown):boolean {return this.knowledge.accept(snapshot);}
  private turn: AudioTurn | null = null;
  private waiters = new Set<() => void>();
  private epoch = 0;
  private portionEvidence: {grams:number;flowId:TabletViewModel["flowId"];session:number;at:number}|null = null;
  constructor(private deps: KitchenActionDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  reset(): void { this.epoch++; this.turn = null; this.portionEvidence = null; this.waiters.forEach(resolve => resolve()); this.waiters.clear(); }
  speechStarted(id: string): void {
    this.epoch++;
    this.waiters.forEach(resolve => resolve()); this.waiters.clear();
    const vm = this.deps.state();
    this.turn = {id, options:optionFingerprint(vm), fingerprint:reviewFingerprint(vm), session:vm.sessionGeneration, transcript:null, receivedAt:this.now(), consumed:false};
  }
  transcript(id: string, text: string): void {
    if (this.turn?.id !== id || this.turn.transcript !== null || text.length > 2000) return;
    this.turn.transcript = text;
    this.turn.receivedAt = this.now();
    this.waiters.forEach(resolve => resolve()); this.waiters.clear();
  }
  async startMealPrep(fromSpeech=false,live:()=>boolean=()=>true):Promise<void>{
    const epoch=this.epoch;
    if(fromSpeech)await this.waitForTranscript();
    if(epoch!==this.epoch||!live())return;
    const stated=fromSpeech&&this.turn&&this.now()-this.turn.receivedAt<=30000?spokenGrams(this.turn.transcript??''):null;
    this.deps.controller.cancelFoodFlow();this.deps.controller.endBowl();
    this.deps.mealPrep?.start(this.deps.state().sessionGeneration);
    await this.deps.controller.searchFood('quaker oats');
    const vm=this.deps.state();this.portionEvidence=stated===null?null:{grams:stated,flowId:vm.flowId,session:vm.sessionGeneration,at:this.now()};this.deps.changed();
  }
  snapshot(): Record<string, unknown> {
    const vm = this.deps.state();
    if (vm.screen === 'locked') return {error:'Member session is locked'};
    return {
      dataNotice:'Demo profile/activity. Food facts carry source provenance. This preview has no physical scale transport.',
      mealPrep:this.deps.mealPrep?.snapshot(vm.sessionGeneration)??null,bowl:this.deps.controller.getBowlState(),
      screen:vm.screen, energy:vm.energy, daily:vm.daily, macros:vm.macros,
      options:vm.options, scale:vm.scale, selectedFood:vm.selectedFood, review:vm.review,
      pendingSpokenGrams:this.portionEvidence && this.portionEvidence.flowId===vm.flowId && this.portionEvidence.session===vm.sessionGeneration && this.now()-this.portionEvidence.at<=120_000 ? this.portionEvidence.grams : null,
      guidance:vm.guidance, error:vm.error === null ? null : 'Kitchen action failed; check the screen',
    };
  }
  private async waitForTranscript(): Promise<void> {
    if (!this.turn || this.turn.transcript !== null) return;
    await new Promise<void>(resolve => {
      const done = () => {clearTimeout(timer);this.waiters.delete(done);resolve();};
      const timer = setTimeout(done, 1800);
      this.waiters.add(done);
    });
  }
  async execute(name: string, raw: string, isLive: () => boolean = () => true): Promise<Record<string, unknown>> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {error:'Invalid tool arguments'};
      args = parsed as Record<string,unknown>;
    } catch {return {error:'Invalid tool arguments'};}
    const expected = (name === 'search_food' || name === 'retrieve_nutrition_knowledge') ? ['query'] : name === 'select_food_option' ? ['optionLabel'] : name === 'select_food' ? ['productVersionId'] : name === 'set_spoken_portion' ? ['grams'] : [];
    if (Object.keys(args).length !== expected.length || Object.keys(args).some(key => !expected.includes(key))) return {error:'Unexpected tool arguments'};
    const epoch = this.epoch;
    const vm = this.deps.state();
    const current = () => isLive() && epoch === this.epoch && this.deps.state().sessionGeneration === vm.sessionGeneration && this.deps.state().screen !== 'locked';
    if (!current()) return {error:'Conversation or member session changed'};
    const controller = this.deps.controller;
    try {
      switch (name) {
        case 'get_kitchen_state': return this.snapshot();
        case 'start_meal_prep':
          if(!this.deps.mealPrep)return {error:'Meal prep is not configured'};
          await this.startMealPrep(true,current);break;
        case 'set_bowl_baseline':
          if(!controller.setBowlBaseline())return {error:'Place the empty bowl on a connected scale and wait for a stable reading first.'};
          break;
        case 'finish_meal_prep':
          if(['weighing','review'].includes(vm.screen))return {error:'Confirm or cancel the pending ingredient before finishing the meal.'};
          controller.cancelFoodFlow();controller.endBowl();this.deps.mealPrep?.finish();break;
        case 'retrieve_nutrition_knowledge':
          if (typeof args.query !== 'string') return {error:'A knowledge question is required'};
          return {...this.knowledge.retrieve(args.query)};
        case 'search_food':
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 120) return {error:'Say a food name'};
          if (!['home','food_search','food_options','logged'].includes(vm.screen)) return {error:'Finish or cancel the current portion first'};
          if (vm.screen === 'logged') controller.cancelFoodFlow();
          await this.waitForTranscript();
          if (!current()) return {error:'Audio turn changed'};
          const stated = this.turn && this.now()-this.turn.receivedAt<=30_000 ? spokenGrams(this.turn.transcript ?? '') : null;
          this.portionEvidence = null;
          await controller.searchFood(args.query.trim());
          if (current() && stated !== null) this.portionEvidence = {grams:stated,flowId:this.deps.state().flowId,session:vm.sessionGeneration,at:this.now()};
          break;
        case 'select_food_option': {
          if(typeof args.optionLabel!=='string'||!['A','B','C','D'].includes(args.optionLabel)||!['food_options','food_search'].includes(vm.screen))return {error:'Choose a currently displayed card'};
          await this.waitForTranscript();
          if(!current())return {error:'Audio turn changed'};
          const options=optionFingerprint(this.deps.state());
          if(!this.turn||!options||this.turn.options!==options||spokenFoodOption(this.turn.transcript??'')!==args.optionLabel||this.now()-this.turn.receivedAt>30_000)return {error:'Please say select option A, B, C or D for the current cards'};
          const choice=this.deps.state().options.find(o=>o.optionLabel===args.optionLabel);
          if(!choice)return {error:'That option is not displayed'};
          await controller.selectProduct(choice.productVersionId);break;
        }
        case 'select_food': {
          if (typeof args.productVersionId !== 'string') return {error:'Choose an offered food'};
          if(this.deps.mealPrep?.enabled()){
            await this.waitForTranscript();if(!current())return {error:'Audio turn changed'};
            if(!this.turn||this.now()-this.turn.receivedAt>30000||this.turn.options!==optionFingerprint(this.deps.state())||spokenNamedFood(this.turn.transcript??'',this.deps.state().options)!==args.productVersionId)return {error:'Say one visible brand or a specific variant, or choose option A, B, C or D.'};
          }
          if (vm.screen === 'home' && vm.guidance.envelopeId !== null) {
            const candidate = [...vm.guidance.candidates,...vm.guidance.alternatives].find(c => c.productVersionId === args.productVersionId);
            if (!candidate) return {error:'That food was not offered'};
            await controller.chooseGuidanceCandidate(candidate.productVersionId, vm.guidance.envelopeId);
          } else {
            if (!['food_search','food_options'].includes(vm.screen) || !vm.options.some(o => o.productVersionId === args.productVersionId)) return {error:'Choose a current search option'};
            await controller.selectProduct(args.productVersionId);
          }
          break;
        }
        case 'set_spoken_portion': {
          if (!['weighing','review'].includes(vm.screen)) return {error:'Choose a food before giving its portion'};
          await this.waitForTranscript();
          if (!current()) return {error:'Audio turn changed'};
          const transcript = this.turn?.transcript ?? '';
          const latest = spokenGrams(transcript);
          const memory = this.portionEvidence;
          // A new numeric, negative or ambiguous statement must never revive an older amount.
          const useMemory = !/[0-9]|\b(?:grams?|g|not|no|cancel|instead|actually)\b/i.test(transcript);
          const remembered = useMemory && memory && memory.flowId === vm.flowId && memory.session === vm.sessionGeneration && this.now()-memory.at<=120_000 ? memory.grams : null;
          const stated = latest ?? remembered;
          if (stated === null || args.grams !== stated || this.now() - (this.turn?.receivedAt ?? 0) > 30_000) return {error:'Please state one portion in grams, for example 180 grams'};
          this.portionEvidence = null;
          controller.enterManualWeight(stated);
          break;
        }
        case 'capture_scale_portion':
          if (vm.screen !== 'weighing' || !vm.scale.connected || !vm.scale.canCommitWeight) return {error:'No connected stable scale reading. Ask for a manual portion in grams.'};
          controller.requestStableWeight();
          break;
        case 'confirm_food_log': {
          await this.waitForTranscript();
          if (!current()) return {error:'Audio turn changed'};
          const turn = this.turn;
          const fingerprint = reviewFingerprint(this.deps.state());
          if (!turn || turn.consumed || !fingerprint || fingerprint !== turn.fingerprint
            || this.now() - turn.receivedAt > 30_000 || !explicitFoodConfirmation(turn.transcript ?? '')) {
            return {error:'Read back the CURRENT food and grams, then ask the user to say confirm in a new turn. No food was logged.'};
          }
          turn.consumed = true;
          this.portionEvidence = null;
          await controller.confirmFoodLog();
          if (!current()) return {error:'Session changed while saving; read current state before proceeding'};
          const result = this.deps.state();
          if (result.screen !== 'logged') {this.deps.changed();return {error:'Food was not saved. Check the current review.',state:this.snapshot()};}
          controller.cancelFoodFlow();
          await controller.refreshDashboard();
          if (!current()) return {error:'Session changed'};
          this.deps.changed();
          return {logged:true,state:this.snapshot(),next:'Briefly acknowledge the saved ingredient. Continue the cooking conversation; offer guidance only when useful or requested.'};
        }
        case 'recommend_next_food':
          if (!this.deps.guidance) return {error:'Validated meal guidance is unavailable',state:this.snapshot()};
          if (vm.screen === 'logged') controller.cancelFoodFlow();
          if (!['home','logged'].includes(vm.screen)) return {error:'Finish or cancel the current portion first'};
          await controller.requestFoodGuidance(this.deps.guidance);
          break;
        case 'cancel_food': this.portionEvidence = null; controller.cancelFoodFlow(); break;
        default: return {error:'Unknown kitchen action'};
      }
      if (!current()) return {error:'Conversation changed; read current state'};
      this.deps.changed();
      return {state:this.snapshot()};
    } catch {this.deps.changed();return {error:'Kitchen action failed. Check the screen and try again.'};}
  }
}
