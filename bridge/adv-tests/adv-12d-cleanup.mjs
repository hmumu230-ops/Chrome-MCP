// adv-12d: close orphaned tab 301370386 (left by a crashed probe run) + final leak check.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async (b) => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return m[m.length - 1];
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v5', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => {
  const m = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const res = m && m.result;
  const tx = (res && res.content && res.content[0] && res.content[0].text) || '';
  if (res && res.isError) return { ok: 0, err: tx };
  try { return { ok: 1, data: JSON.parse(tx) }; } catch { return { ok: 1, data: tx }; }
};
const lst0 = (await call('list_pages', {})).data;
const lst = lst0.items || lst0;
console.log('current tabs:', lst.map(t => t.pageId + ':' + (t.url || '').slice(0, 45)).join('\n  '));
const orphan = 301370386;
if (lst.some(t => t.pageId === orphan)) {
  const c = await call('close_page', { pageId: orphan });
  console.log('closed orphan', orphan, c.ok ? 'OK' : c.err);
} else console.log('orphan', orphan, 'already gone');
const fin0 = (await call('list_pages', {})).data;
const fin = fin0.items || fin0;
console.log('final count:', fin.length);
