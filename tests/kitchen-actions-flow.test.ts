import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TabletAppController,appSubjectFrom} from '@macros/tablet-app-core';
import {mintSubjectForTests} from '@macros/domain-auth';
import {InMemoryEnergyGoalRepository,InMemoryFoodLogRepository,InMemoryProductVersionRepository,InMemoryUserProfileRepository} from '@macros/persistence';
import {buildViewModel} from '@macros/tablet-view-model';
import {deriveCapabilities} from '@macros/domain-offline-sync';
import {activeSwitchState} from '@macros/domain-household';
import {instant} from '@macros/contracts';
import {PROFILE_MALE_35,SYNTHETIC_PRODUCTS,SYNTHETIC_CATALOG_HEADS,SYNTHETIC_STABILITY_POLICY,TEST_TEF_POLICY,activeEnergy,USER_A} from '@macros/testkit';
async function harness(remoteProducts?:InMemoryProductVersionRepository) {
  const mod = await import('../apps/tablet/src/voice/kitchen-actions.js') as unknown as {
    KitchenActions?: typeof import('../apps/tablet/src/voice/kitchen-actions.js').KitchenActions;
    default?: {KitchenActions: typeof import('../apps/tablet/src/voice/kitchen-actions.js').KitchenActions};
  };
  const KitchenActions = mod.KitchenActions ?? mod.default!.KitchenActions;
  const repos = {foodLogs:new InMemoryFoodLogRepository(),products:remoteProducts??new InMemoryProductVersionRepository(SYNTHETIC_PRODUCTS,SYNTHETIC_CATALOG_HEADS),profiles:new InMemoryUserProfileRepository(),goals:new InMemoryEnergyGoalRepository()};
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.goals.append({goalVersionId:'goal',userId:USER_A,effectiveFrom:instant('2026-01-01T00:00:00Z'),goal:'lose',targetDeltaKcal:-300});
  let sequence=0;let now=1000;
  const controller = new TabletAppController({repositories:repos,clock:{now:()=>instant('2026-08-11T16:50:00.000Z')},ids:{next:()=>`voice-log-${++sequence}`},policies:{tefPolicy:{status:'available',policy:TEST_TEF_POLICY}},stabilityPolicy:SYNTHETIC_STABILITY_POLICY,timezone:'America/Chicago'},appSubjectFrom(mintSubjectForTests(USER_A)),activeEnergy(500));
  await controller.refreshDashboard();
  const state=()=>buildViewModel({app:controller.getState(),capabilities:deriveCapabilities({backendReachable:true,catalogInstalled:true,catalogStale:false,localStorageWritable:true,authValid:true,cloudVoiceReachable:true,pendingSubmissions:0}),switchState:activeSwitchState(USER_A,controller.getState().sessionGeneration),recent:[]});
  const actions = new KitchenActions({controller,state,changed:()=>{},now:()=>now});
  const execute=(name:string,args:unknown={})=>actions.execute(name,JSON.stringify(args));
  const portion=async()=>{
    actions.speechStarted('food');actions.transcript('food','I am having cooked chicken');
    await execute('search_food',{query:'chicken'});
    const option=state().options.find(o=>o.preparationState==='cooked');assert.ok(option);
    await execute('select_food',{productVersionId:option.productVersionId});
    actions.speechStarted('weight');actions.transcript('weight','I have 186 grams');
    await execute('set_spoken_portion',{grams:186});assert.equal(state().screen,'review');
  };
  return {actions,controller,repos,state,execute,portion,advance:()=>{now+=31_000;}};
}
test('spoken food → offered choice → stated grams → fresh confirmation → persisted log and recomputed day',async()=>{
  const h=await harness();await h.portion();const review=h.state().review!;
  assert.ok(review.kcal>0);assert.equal(review.grams,186);
  assert.ok('error' in await h.execute('confirm_food_log')); // weight utterance is not confirmation
  h.actions.speechStarted('confirm');h.actions.transcript('confirm','Yes, log it.');
  const result=await h.execute('confirm_food_log');assert.equal(result.logged,true);assert.equal(h.state().screen,'home');
  assert.equal(h.controller.getState().dashboard!.intake.kcal,review.kcal);
  assert.equal(h.controller.getState().dashboard!.intake.proteinG,review.proteinG);
  await h.execute('confirm_food_log');
  const logs=await h.repos.foodLogs.listByLocalDate(USER_A,h.controller.getState().dashboard!.localDate);assert.equal(logs.length,1);
});
test('confirmation before review and negated confirmation do not log food',async()=>{
  const h=await harness();h.actions.speechStarted('earlier');h.actions.transcript('earlier','confirm');await h.portion();
  assert.ok('error' in await h.execute('confirm_food_log'));
  h.actions.speechStarted('no');h.actions.transcript('no','do not log it');assert.ok('error' in await h.execute('confirm_food_log'));
  assert.equal(h.state().screen,'review');assert.equal(h.controller.getState().dashboard!.intake.kcal,0);
});
test('changing portion after spoken confirmation invalidates it',async()=>{
  const h=await harness();await h.portion();h.actions.speechStarted('confirm');h.actions.transcript('confirm','confirm');h.controller.enterManualWeight(100);
  assert.ok('error' in await h.execute('confirm_food_log'));assert.equal(h.controller.getState().dashboard!.intake.kcal,0);
});
test('stale transcript, ended session and invented weights are refused',async()=>{
  const h=await harness();await h.portion();h.actions.speechStarted('confirm');h.actions.transcript('confirm','confirm');h.advance();assert.ok('error' in await h.execute('confirm_food_log'));
  h.actions.reset();assert.ok('error' in await h.execute('confirm_food_log'));
  assert.ok('error' in await h.actions.execute('get_kitchen_state','{}',()=>false));
  h.controller.cancelWeight();h.actions.speechStarted('weight');h.actions.transcript('weight','100 grams');assert.ok('error' in await h.execute('set_spoken_portion',{grams:200}));
});
test('unknown ids, unexpected arguments and unconnected scale cannot mutate the food flow',async()=>{
  const h=await harness();await h.execute('search_food',{query:'chicken'});
  assert.ok('error' in await h.execute('select_food',{productVersionId:'invented'}));
  assert.ok('error' in await h.execute('get_kitchen_state',{userId:'other'}));
  assert.ok('error' in await h.execute('capture_scale_portion'));
  assert.equal(h.controller.getState().addFood.selected,null);
});
test('late transcription can authorize the same current review, but not an interrupted turn',async()=>{
  const h=await harness();await h.portion();h.actions.speechStarted('confirm');const pending=h.execute('confirm_food_log');
  h.actions.transcript('confirm','confirm');assert.equal((await pending).logged,true);
  await h.portion();h.actions.speechStarted('second-confirm');const interrupted=h.execute('confirm_food_log');
  h.actions.speechStarted('new-turn');h.actions.transcript('second-confirm','confirm');assert.ok('error' in await interrupted);
});
test('knowledge retrieval works during review without changing a pending food or granting log authority',async()=>{
  const h=await harness();await h.portion();const review=h.state().review;
  const result=await h.execute('retrieve_nutrition_knowledge',{query:'How does my calorie deficit budget work?'});
  assert.equal(result.status,'matched');assert.deepEqual(h.state().review,review);
  assert.ok('error' in await h.execute('confirm_food_log'));
  assert.ok('error' in await h.execute('retrieve_nutrition_knowledge',{query:'food',userId:'other'}));
});
test('voice chooses the same displayed product card by letter without logging it',async()=>{
 const h=await harness();await h.execute('search_food',{query:'chicken'});
 const option=h.state().options[1];assert.ok(option);
 h.actions.speechStarted('choice');h.actions.transcript('choice',`select option ${option.optionLabel}`);
 await h.execute('select_food_option',{optionLabel:option.optionLabel});
 assert.equal(h.state().selectedFood?.productVersionId,option.productVersionId);assert.equal(h.state().screen,'weighing');
 assert.equal(h.controller.getState().dashboard!.intake.kcal,0);
});
test('voice card selection refuses invented letters, mismatched speech and changed offers',async()=>{
 const h=await harness();await h.execute('search_food',{query:'chicken'});
 h.actions.speechStarted('choice');h.actions.transcript('choice','select option A');
 assert.ok('error' in await h.execute('select_food_option',{optionLabel:'B'}));
 assert.ok('error' in await h.execute('select_food_option',{optionLabel:'Z'}));
 await h.execute('search_food',{query:'tofu'});
 assert.ok('error' in await h.execute('select_food_option',{optionLabel:'A'}));
 assert.equal(h.state().selectedFood,null);
});

test('grocery candidate lookup is shared by voice search, visible cards and confirmed logging',async()=>{
 const {readFileSync}=await import('node:fs');
 const seed=JSON.parse(readFileSync('data/grocery-preview-seed.json','utf8'));
 const version=seed.products[0].version;
 let searched='';
 class GroceryRepository extends InMemoryProductVersionRepository {
  async searchCandidates(query:string){searched=query;return this.listSearchable();}
 }
 const repo=new GroceryRepository([version],[{productId:version.productId,currentProductVersionId:version.productVersionId,isActive:true,updatedAt:version.effectiveFrom}]);
 const h=await harness(repo);
 h.actions.speechStarted('grocery');h.actions.transcript('grocery',version.displayName);
 await h.execute('search_food',{query:version.displayName});assert.equal(searched,version.displayName);
 assert.equal(h.state().options[0]?.productVersionId,version.productVersionId);
 h.actions.speechStarted('choice');h.actions.transcript('choice','Select option A');
 assert.equal((await h.execute('select_food_option',{optionLabel:'A'})).error,undefined);
 h.actions.speechStarted('grams');h.actions.transcript('grams','32 grams');await h.execute('set_spoken_portion',{grams:32});
 assert.equal(h.state().review?.grams,32);assert.equal(h.controller.getState().dashboard!.intake.kcal,0);
 h.actions.speechStarted('save');h.actions.transcript('save','Yes log it');assert.equal((await h.execute('confirm_food_log')).logged,true);
 assert.ok(h.controller.getState().dashboard!.intake.kcal>0);
});

test('natural yes confirms only a fresh review; corrections require a new confirmation',async()=>{
 const h=await harness();await h.portion();
 h.actions.speechStarted('correction');h.actions.transcript('correction','Actually make it 180 grams');
 assert.equal((await h.execute('set_spoken_portion',{grams:180})).error,undefined);
 assert.equal(h.state().review?.grams,180);
 assert.ok('error' in await h.execute('confirm_food_log'));
 h.actions.speechStarted('yes');h.actions.transcript('yes','Yes.');
 assert.equal((await h.execute('confirm_food_log')).logged,true);
 assert.ok('error' in await h.execute('confirm_food_log'));
});
test('real ingredient library supports successive foods in one session without duplicate logs',async()=>{
 const {KITCHEN_LIBRARY}=await import('../packages/catalog-runtime/src/kitchen-library.generated.js');
 const foods=['tomatoes','rice','chicken'].map(query=>KITCHEN_LIBRARY.find(p=>p.displayName.toLowerCase().includes(query)&&p.preparationState==='raw')!);
 assert.ok(foods.every(Boolean));
 const repo=new InMemoryProductVersionRepository(foods,foods.map(p=>({productId:p.productId,currentProductVersionId:p.productVersionId,isActive:true,updatedAt:p.effectiveFrom})));
 const h=await harness(repo);let expected=0;
 for(const [i,p] of foods.entries()){
  h.actions.speechStarted(`food-${i}`);h.actions.transcript(`food-${i}`,`Log 100 grams of ${p.displayName}`);
  await h.execute('search_food',{query:p.displayName});
  await h.execute('select_food',{productVersionId:p.productVersionId});
  assert.equal((await h.execute('set_spoken_portion',{grams:100})).error,undefined);
  expected+=h.state().review!.kcal;
  h.actions.speechStarted(`confirm-${i}`);h.actions.transcript(`confirm-${i}`,'yes');
  assert.equal((await h.execute('confirm_food_log')).logged,true);
 }
 assert.equal(h.controller.getState().dashboard!.intake.kcal,expected);
 const logs=await h.repos.foodLogs.listByLocalDate(USER_A,h.controller.getState().dashboard!.localDate);assert.equal(logs.length,3);
});

test('amount spoken before card selection is retained only for the same pending food',async()=>{
 const h=await harness();
 h.actions.speechStarted('initial');h.actions.transcript('initial','Log 80 grams of chicken');
 await h.execute('search_food',{query:'chicken'});
 h.actions.speechStarted('choice');h.actions.transcript('choice','Option A');
 await h.execute('select_food_option',{optionLabel:'A'});
 assert.equal((await h.execute('set_spoken_portion',{grams:80})).error,undefined);
 assert.equal(h.state().review?.grams,80);
 assert.ok('error' in await h.execute('confirm_food_log'));
 await h.execute('cancel_food');
 await h.execute('search_food',{query:'chicken'});
 await h.execute('select_food',{productVersionId:h.state().options[0]!.productVersionId});
 h.actions.speechStarted('later');h.actions.transcript('later','Option A');
 assert.ok('error' in await h.execute('set_spoken_portion',{grams:80}));
});
test('ambiguous newer quantity cannot fall back to an older spoken amount',async()=>{
 const h=await harness();
 h.actions.speechStarted('initial');h.actions.transcript('initial','80 grams of chicken');
 await h.execute('search_food',{query:'chicken'});
 await h.execute('select_food',{productVersionId:h.state().options[0]!.productVersionId});
 h.actions.speechStarted('ambiguous');h.actions.transcript('ambiguous','Actually 100 grams or 120 grams');
 assert.ok('error' in await h.execute('set_spoken_portion',{grams:80}));
 assert.equal(h.state().screen,'weighing');
});

test('full offline catalog returns real options for everyday kitchen searches',async()=>{
 const {KITCHEN_LIBRARY}=await import('../packages/catalog-runtime/src/kitchen-library.generated.js');
 const repo=new InMemoryProductVersionRepository(KITCHEN_LIBRARY,KITCHEN_LIBRARY.map(p=>({productId:p.productId,currentProductVersionId:p.productVersionId,isActive:true,updatedAt:p.effectiveFrom})));
 const h=await harness(repo);
 for(const query of ['oats','tomatoes','rice','chicken','tofu','milk','lentils','salmon']){
  await h.execute('search_food',{query});
  assert.ok(h.state().options.length>0,query);
  assert.ok(h.state().options.some(o=>o.displayName.toLowerCase().includes(query)),query);
 }
});
