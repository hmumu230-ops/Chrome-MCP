const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: t }; }
}
const init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe11', version: '0' } });
console.log('init status', init.status, 'sid', sid, JSON.stringify(init.body).slice(0, 200));
if (init.status === 200) {
  const t0 = Date.now();
  const r = await req('tools/call', { name: 'list_pages', arguments: {} }, 2);
  console.log('list_pages', Date.now() - t0, 'ms', JSON.stringify(r.body).slice(0, 300));
}
process.exit(0);
