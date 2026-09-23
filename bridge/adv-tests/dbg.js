const BASE = 'http://127.0.0.1:7890/mcp';
const res = await fetch(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'd', version: '0' } } }),
});
console.log('status', res.status, 'sid', res.headers.get('mcp-session-id'), 'ctype', res.headers.get('content-type'));
const reader = res.body.getReader();
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  const r = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 8000 - (Date.now() - t0)))]);
  if (r.done) { console.log('STREAM END'); break; }
  console.log(`[+${Date.now() - t0}ms]`, JSON.stringify(new TextDecoder().decode(r.value)));
}
process.exit(0);
