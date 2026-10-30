import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MealPrepCatalog,OVERNIGHT_DEMO} from '../packages/catalog-runtime/src/meal-prep-catalog.js';
import {MealPrepSession,spokenNamedFood} from '@macros/tablet-voice';
import {TabletAppController,DevScaleAdapter,appSubjectFrom} from '@macros/tablet-app-core';
import {mintSubjectForTests} from '@macros/domain-auth';
import {InMemoryFoodLogRepository,InMemoryProductVersionRepository,InMemoryUserProfileRepository,InMemoryEnergyGoalRepository} from '@macros/persistence';
import {buildViewModel} from '@macros/tablet-view-model';
import {deriveCapabilities} from '@macros/domain-offline-sync';
import {activeSwitchState} from '@macros/domain-household';
import {instant,validateProductVersion} from '@macros/contracts';
import {PROFILE_MALE_35,USER_A,SYNTHETIC_STABILITY_POLICY,TEST_TEF_POLICY,activeEnergy} from '@macros/testkit';
async function harness(){
 const mod=await import('../apps/tablet/src/voice/kitchen-actions.js') as any;const KitchenActions=mod.KitchenActions??mod.default.KitchenActions;
 const meal=new MealPrepSession();const products=new MealPrepCatalog(new InMemoryProductVersionRepository([],[]),()=>meal.enabled());
 const repos={products,foodLogs:new InMemoryFoodLogRepository(),profiles:new InMemoryUserProfileRepository(),goals:new InMemoryEnergyGoalRepository()};
 await repos.profiles.append(PROFILE_MALE_35);await repos.goals.append({userId:USER_A,goalVersionId:'goal',goal:'lose',targetDeltaKcal:-300,effectiveFrom:instant('2026-01-01T00:00:00Z')});
 let ms=Date.parse('2026-10-30T12:00:00Z'),n=0;const clock={now:()=>instant(new Date(ms).toISOString()),advance:(delta:number)=>{ms+=delta;}};
 const controller=new TabletAppController({repositories:repos,clock,ids:{next:()=>`meal-log-${++n}`},policies:{tefPolicy:{status:'available',policy:TEST_TEF_POLICY}},stabilityPolicy:SYNTHETIC_STABILITY_POLICY,timezone:'America/Chicago',onFoodLogged:e=>meal.record(e,e.sessionGeneration)},appSubjectFrom(mintSubjectForTests(USER_A)),activeEnergy(500));
 await controller.refreshDashboard();
 const state=()=>buildViewModel({app:controller.getState(),capabilities:deriveCapabilities({backendReachable:true,catalogInstalled:true,catalogStale:false,localStorageWritable:true,authValid:true,cloudVoiceReachable:true,pendingSubmissions:0}),switchState:activeSwitchState(USER_A,controller.getState().sessionGeneration),recent:[]});
 const actions=new KitchenActions({controller,mealPrep:meal,state,changed:()=>{},now:()=>ms});const execute=(name:string,args:unknown={})=>actions.execute(name,JSON.stringify(args));
 let turn=0;const say=(text:string)=>{const id=`turn-${++turn}`;actions.speechStarted(id);actions.transcript(id,text);};
 const scale=new DevScaleAdapter(clock.now(),clock);const feed=(events:ReturnType<typeof scale.connect>)=>events.forEach(e=>controller.applyScaleEvent(e));
 return {meal,products,controller,repos,state,actions,execute,say,scale,feed,clock};
}
test('eighteen sourced choices have photos, valid facts and correct option sets',()=>{
 assert.equal(OVERNIGHT_DEMO.length,18);
 for(const food of OVERNIGHT_DEMO){assert.equal(validateProductVersion(food.version).ok,true,food.id);assert.ok(food.image.url.startsWith('https://'));assert.ok(food.sourceUrl.startsWith('https://'));}
});
test('seven voice-selected ingredients accumulate exact product macros, without duplicate confirmation',async()=>{
 const h=await harness();await h.execute('start_meal_prep');let kcal=0;
 for(const [query,count,choice,grams] of [['quaker oats',3,'B',80],['blueberries',1,'A',50],['strawberries',1,'A',40],['peanut butter',3,'Jif',20],['milk',4,'D',150],['dark chocolate',3,'Lindt',10],['protein powder',3,'Dymatize',30]] as const){
  h.say(query);await h.execute('search_food',{query});assert.equal(h.state().options.length,count,query);
  assert.deepEqual(h.state().options.map(o=>o.optionLabel),['A','B','C','D'].slice(0,count));
  h.say(choice);
  if(choice.length===1)assert.equal((await h.execute('select_food_option',{optionLabel:choice})).error,undefined);
  else {const chosen=spokenNamedFood(choice,h.state().options);assert.ok(chosen);assert.equal((await h.execute('select_food',{productVersionId:chosen})).error,undefined);}
  h.say(`${grams} grams`);await h.execute('set_spoken_portion',{grams});assert.equal(h.state().review?.grams,grams);
  kcal+=h.state().review!.kcal;h.say('yes');assert.equal((await h.execute('confirm_food_log')).logged,true);
  assert.ok('error' in await h.execute('confirm_food_log'));
 }
 const meal=h.meal.snapshot(h.state().sessionGeneration)!;assert.equal(meal.items.length,7);assert.ok(Math.abs(meal.totals.kcal-kcal)<1e-8);
 assert.ok(Math.abs(h.controller.getState().dashboard!.intake.kcal-kcal)<1e-8);
 assert.equal((await h.repos.foodLogs.listByLocalDate(USER_A,h.controller.getState().dashboard!.localDate)).length,7);
});
test('shared bowl captures added ingredient mass, preserving raw scale evidence',async()=>{
 const h=await harness();await h.execute('start_meal_prep');h.feed(h.scale.connect());h.feed(h.scale.placeAndSettle(500));
 assert.equal(h.controller.setBowlBaseline(),true);
 for(const [query,gross,net] of [['quaker oats',580,80],['blueberries',630,50]] as const){
  h.say(query);await h.execute('search_food',{query});h.say('option A');await h.execute('select_food_option',{optionLabel:'A'});
  h.feed(h.scale.placeAndSettle(gross));assert.equal((await h.execute('capture_scale_portion')).error,undefined);
  assert.equal(h.state().review?.grams,net);const capture=h.controller.getState().addFood.weightCapture!;
  assert.equal(capture.source,'scale');assert.equal(capture.bowlDifference?.gross.grams,gross);assert.equal(capture.bowlDifference?.baseline.grams,gross-net);
  h.say('confirm');assert.equal((await h.execute('confirm_food_log')).logged,true);
 }
 assert.equal(h.meal.snapshot(h.state().sessionGeneration)?.totals.grams,130);
});
test('tare changes, removal and manual corrections cannot reuse a bowl baseline',async()=>{
 const h=await harness();await h.execute('start_meal_prep');h.feed(h.scale.connect());h.feed(h.scale.placeAndSettle(500));assert.equal(h.controller.setBowlBaseline(),true);
 h.say('option A');await h.execute('select_food_option',{optionLabel:'A'});
 h.feed(h.scale.tare());h.feed(h.scale.placeAndSettle(580));await h.execute('capture_scale_portion');assert.equal(h.state().review,null);
 h.say('80 grams');await h.execute('set_spoken_portion',{grams:80});assert.equal(h.controller.getBowlState().active,false);
});
test('ambiguous or mismatched spoken brands cannot select another card',async()=>{
 const h=await harness();await h.execute('start_meal_prep');h.say('peanut butter');await h.execute('search_food',{query:'peanut butter'});
 h.say('Jif');const wrong=h.state().options.find(o=>o.brand==='Skippy')!;
 assert.ok('error' in await h.execute('select_food',{productVersionId:wrong.productVersionId}));assert.equal(h.state().selectedFood,null);
 assert.equal(spokenNamedFood('peanut butter',h.state().options),null);
});
test('touch confirmation uses the same meal ledger and nutritional calculation',async()=>{
 const h=await harness();await h.execute('start_meal_prep');await h.controller.selectProduct(h.state().options[0]!.productVersionId);
 h.controller.enterManualWeight(80);const expected=h.state().review!.kcal;await h.controller.confirmFoodLog();await h.controller.confirmFoodLog();
 assert.equal(h.meal.snapshot(h.state().sessionGeneration)?.items.length,1);assert.equal(h.meal.snapshot(h.state().sessionGeneration)?.totals.kcal,expected);
});

test('natural milk names resolve uniquely, and finishing cannot silently drop a pending portion',async()=>{
 const h=await harness();await h.execute('start_meal_prep');h.say('milk');await h.execute('search_food',{query:'milk'});
 const almond=spokenNamedFood('go with almondmilk',h.state().options);assert.ok(almond);
 h.say('go with almondmilk');assert.equal((await h.execute('select_food',{productVersionId:almond})).error,undefined);
 assert.ok('error' in await h.execute('finish_meal_prep'));
 h.say('150 grams');await h.execute('set_spoken_portion',{grams:150});h.say('confirm');await h.execute('confirm_food_log');
 assert.equal((await h.execute('finish_meal_prep')).error,undefined);assert.equal(h.meal.snapshot(h.state().sessionGeneration)?.active,false);
});
test('initial spoken amount survives starting the demo and choosing an oat variant',async()=>{
 const h=await harness();h.say('Make overnight oats with 80 grams');await h.execute('start_meal_prep');h.say('option C');await h.execute('select_food_option',{optionLabel:'C'});
 assert.equal((await h.execute('set_spoken_portion',{grams:80})).error,undefined);assert.equal(h.state().review?.grams,80);
});

test('bowl evidence cannot be attached to manual or arithmetically altered captures',async()=>{
 const {validateWeightCapture}=await import('@macros/contracts');
 const h=await harness();await h.execute('start_meal_prep');h.feed(h.scale.connect());h.feed(h.scale.placeAndSettle(500));h.controller.setBowlBaseline();h.say('option A');await h.execute('select_food_option',{optionLabel:'A'});h.feed(h.scale.placeAndSettle(580));await h.execute('capture_scale_portion');
 const capture=h.controller.getState().addFood.weightCapture!;assert.equal(validateWeightCapture(capture).ok,true);
 assert.equal(validateWeightCapture({...capture,grams:580 as typeof capture.grams}).ok,false);
 assert.equal(validateWeightCapture({...capture,source:'manual'}).ok,false);
 assert.equal(validateWeightCapture({...capture,bowlDifference:null} as any).ok,false);
});
