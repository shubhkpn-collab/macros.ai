import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenRealtimeProvider, validOffer, KITCHEN_TOOLS } from '../packages/voice-openai/src/realtime.js';
import { kitchenVoiceRoute } from '../packages/runtime-api/src/kitchen-voice-route.js';
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
test('audio handshake rejects malformed and oversized offers', () => {
  for (const value of [null, '', {}, 'v=0\nm=video 9', `${sdp}${'x'.repeat(32768)}`]) assert.equal(validOffer(value), false);
  assert.equal(validOffer(sdp), true);
});
test('server binds topic, tools and privacy identifier; returns only SDP', async () => {
  let calls = 0;
  const provider = createKitchenRealtimeProvider('server-only-test-key', 'gpt-realtime-2.1', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer server-only-test-key');
    assert.notEqual((init?.headers as Record<string,string>)['OpenAI-Safety-Identifier'], 'person-id');
    const body = init?.body as FormData;
    const config = JSON.parse(String(body.get('session')));
    assert.match(config.instructions, /Discuss only food/);
    assert.deepEqual(config.tools, KITCHEN_TOOLS);
    assert.equal(body.get('sdp'), sdp);
    return new Response(sdp, {status:201});
  });
  assert.deepEqual(await provider.connect(sdp,'person-id'), {sdp});
  assert.equal(calls,1);
  assert.equal(await provider.connect('bad','person-id'), null);
  assert.equal(calls,1);
});
test('provider errors never expose credentials or vendor error text', async () => {
  const provider = createKitchenRealtimeProvider('secret', undefined, async () => new Response('secret raw diagnostics', {status:401}));
  assert.equal(await provider.connect(sdp,'user'),null);
});
test('missing key does not call paid API', async () => {
  let called = false;
  const provider = createKitchenRealtimeProvider('', undefined, async () => { called = true; throw new Error('unexpected'); });
  assert.equal(await provider.connect(sdp,'user'),null);
  assert.equal(called,false);
});
test('production voice route requires an authenticated subject', async () => {
  let called = false;
  const route = kitchenVoiceRoute({connect:async () => {called = true;return {sdp};}});
  const result = await route.handler({requestId:'test',userId:'claimed',body:{sdp}});
  assert.equal(called,false);
  assert.equal((result as {code:string}).code,'missing_credential');
});
