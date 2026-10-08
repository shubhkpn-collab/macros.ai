/** Local USB preview only. Not a production authentication server. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createKitchenRealtimeProvider, validOffer } from '../packages/voice-openai/src/realtime.js';

const settings = readFileSync('.env.realtime.local', 'utf8');
function setting(name: string): string {
  return settings.split('\n').find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? '';
}
const key = setting('OPENAI_API_KEY');
const provider = createKitchenRealtimeProvider(key, setting('OPENAI_REALTIME_MODEL') || 'gpt-realtime-2.1');
const token = randomBytes(32).toString('hex');
// Scoped preview token, not an OpenAI key. Ignored file, owner-only permissions.
writeFileSync('.env.realtime.connection', token, { mode: 0o600 });
let nextSessionAt = 0;
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  const respond = (status: number, body: unknown) => { res.writeHead(status); res.end(JSON.stringify(body)); };
  const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    respond(401, { error: 'Not authorized' }); return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    respond(200, { configured: key.length > 0, preview: true }); return;
  }
  if (req.method !== 'POST' || req.url !== '/voice/conversation') {
    respond(404, { error: 'Not found' }); return;
  }
  if (!key) { respond(503, { error: 'OpenAI key is not configured on the Mac' }); return; }
  if (Date.now() < nextSessionAt) { respond(429, { error: 'Please wait before starting another conversation' }); return; }
  let body = '';
  try {
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 40_000) { respond(413, { error: 'Request too large' }); return; }
    }
    const input: unknown = JSON.parse(body);
    if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(k => k !== 'sdp') || !validOffer((input as {sdp?: unknown}).sdp)) {
      respond(400, { error: 'Invalid audio offer' }); return;
    }
    nextSessionAt = Date.now() + 30_000;
    const result = await provider.connect((input as {sdp: string}).sdp, 'local-synthetic-kitchen-preview');
    respond(result ? 200 : 502, result ?? { error: 'Voice provider unavailable; check project access and billing' });
  } catch { respond(400, { error: 'Invalid request' }); }
});
server.requestTimeout = 25_000;
server.listen(8791, '127.0.0.1', () => console.log(`MACROS USB voice backend ready. API key ${key ? 'configured' : 'not configured'}.`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
