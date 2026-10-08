import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KitchenSession,explicitFoodConfirmation,spokenGrams} from '@macros/tablet-voice';
function harness() {
  const sent: unknown[] = []; const calls: string[] = []; const transcripts: string[] = [];
  let ended = false; let release: (() => void) | undefined;
  const session = new KitchenSession({send:e => sent.push(e),execute:async (name,_args,current) => {
    if (release) await new Promise<void>(resolve => {release = resolve;});
    if (current()) calls.push(name);return {ok:true};
  },speechStarted:() => {},transcript:(_id,text) => transcripts.push(text),status:()=>{},end:()=>{ended=true;session.close();}});
  const speech = (id='u1') => session.handle({type:'input_audio_buffer.speech_started',item_id:id});
  const created = (id='r1') => session.handle({type:'response.created',response:{id}});
  const done = (status='completed',id='r1',call='c1') => session.handle({type:'response.done',response:{id,status,output:[{type:'function_call',call_id:call,name:'search_food',arguments:'{"query":"tofu"}'}]}});
  return {session,sent,calls,transcripts,speech,created,done,ended:()=>ended,hold:()=>{release=()=>{};},release:()=>release?.()};
}
test('continuous audio: one greeting, one tool continuation, duplicate events do not repeat writes',async()=>{
  const h=harness();h.session.ready();await h.speech();await h.created();await h.done();await h.done();
  assert.deepEqual(h.calls,['search_food']);assert.equal(h.sent.length,3);
});
test('cancelled/incomplete response and arguments done never run a kitchen action',async()=>{
  const h=harness();await h.speech();await h.created();
  await h.session.handle({type:'response.function_call_arguments.done',name:'confirm_food_log',call_id:'c',arguments:'{}'});
  await h.done('cancelled');assert.deepEqual(h.calls,[]);
});
test('barge-in invalidates older response even if its completed event arrives late',async()=>{
  const h=harness();await h.speech();await h.created();await h.speech('u2');await h.done();assert.deepEqual(h.calls,[]);
});
test('ending the conversation blocks late tool results and future audio events',async()=>{
  const h=harness();await h.speech();await h.created();h.session.close();await h.done();assert.deepEqual(h.calls,[]);assert.deepEqual(h.sent,[]);
});
test('transcripts are final, current and processed once; explicit end shuts session',async()=>{
  const h=harness();await h.speech();
  await h.session.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'old',transcript:'confirm'});
  await h.session.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'end conversation'});
  assert.deepEqual(h.transcripts,['end conversation']);assert.equal(h.ended(),true);
});
test('confirmation rejects negative, ambiguous and quoted requests',()=>{
  for (const text of ['do not log it','I said confirm yesterday','maybe confirm','yes','confirm or cancel','don’t confirm']) assert.equal(explicitFoodConfirmation(text),false,text);
  for (const text of ['Confirm.','Log it','Yes, log it please']) assert.equal(explicitFoodConfirmation(text),true,text);
});
test('manual portions require one positive spoken amount with grams; no invented or conflicting weight',()=>{
  assert.equal(spokenGrams('I have 186 grams of chicken'),186);
  assert.equal(spokenGrams('94.5 g'),94.5);
  for (const text of ['186','0 grams','not 186 grams','186 grams or 100 grams','actually 180 grams','-180 grams']) assert.equal(spokenGrams(text),null,text);
});

test('interruption during an awaited tool prevents its late result from continuing speech',async()=>{
  const h=harness();await h.speech();await h.created();h.hold();
  const pending=h.done();await Promise.resolve();
  await h.speech('new-turn');h.release();await pending;
  assert.deepEqual(h.calls,[]);assert.deepEqual(h.sent,[]);
});
