const BASE = 'http://127.0.0.1:7890/mcp';
async function call(body, sid, tag) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const t0 = Date.now();
  const res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  console.log(`[${tag}] status ${res.status} sid=${res.headers.get('mcp-session-id')} ctype=${res.headers.get('content-type')} +${Date.now() - t0}ms`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (Date.now() - t0 < 15000) {
    const r = await reader.read();
    if (r.done) { console.log(`[${tag}] END +${Date.now() - t0}ms`); break; }
    console.log(`[${tag}] +${Date.now() - t0}ms`, dec.decode(r.value).slice(0, 500));
  }
  return res.headers.get('mcp-session-id');
}
const sid = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'd', version: '0' } } }, null, 'init');
await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 'notif');
await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, sid, 'call');
process.exit(0);
