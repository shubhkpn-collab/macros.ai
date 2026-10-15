import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyPilotUsage,addPilotUsage} from '@macros/tablet-voice';
test('pilot records reported usage including cached and audio counts without transcript data',()=>{
  const result=addPilotUsage(emptyPilotUsage(),{input_tokens:1000,output_tokens:200,input_token_details:{cached_tokens:400,audio_tokens:600},output_token_details:{audio_tokens:150},transcript:'PRIVATE'});
  assert.equal(result.inputTokens,1000);assert.equal(result.cachedInputTokens,400);assert.equal(result.outputAudioTokens,150);assert.equal(result.missingUsageResponses,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|transcript/);
});
test('missing usage is explicitly incomplete rather than a zero-cost claim',()=>{
  assert.equal(addPilotUsage(emptyPilotUsage(),null).missingUsageResponses,1);
  const result=addPilotUsage(emptyPilotUsage(),{input_tokens:-3,output_tokens:Infinity});
  assert.equal(result.inputTokens,0);assert.equal(result.outputTokens,0);assert.equal(result.missingUsageResponses,1);
});
test('protocol accounts cancelled responses once even when no tool can execute',async()=>{
  const {KitchenSession}=await import('@macros/tablet-voice');let total=emptyPilotUsage();
  const session=new KitchenSession({send:()=>{},execute:async()=>({}),speechStarted:()=>{},transcript:()=>{},status:()=>{},end:()=>{},usage:value=>{total=addPilotUsage(total,value);}});
  const event={type:'response.done',response:{id:'cancelled-response',status:'cancelled',usage:{input_tokens:20,output_tokens:5},output:[]}};
  await session.handle(event);await session.handle(event);
  assert.equal(total.responses,1);assert.equal(total.inputTokens,20);
  session.close();await session.handle({...event,response:{...event.response,id:'late'}});
  assert.equal(total.responses,1);
});
