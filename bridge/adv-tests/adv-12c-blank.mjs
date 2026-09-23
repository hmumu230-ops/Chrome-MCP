// adv-12c: is a new_page default (about:blank) tab scriptable? foreground + background.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async (b) => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return m[m.length - 1];
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v4', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => {
  const m = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const res = m && m.result;
  if (!res) return { ok: 0, err: 'nores' };
  const tx = (res.content && res.content[0] && res.content[0].text) || '';
  if (res.isError) return { ok: 0, err: tx };
  try { return { ok: 1, data: JSON.parse(tx) }; } catch { return { ok: 1, data: res.structuredContent || tx }; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const bg of [false, true]) {
  const r = await call('new_page', { url: 'about:blank', background: bg });
  const p = r.data.pageId;
  await sleep(600);
  const ev = await call('evaluate_script', { pageId: p, function: '() => 1' });
  const sn = await call('take_snapshot', { pageId: p });
  console.log(`background=${bg} tab=${p}`);
  console.log('   evaluate_script:', ev.ok ? 'OK ' + JSON.stringify(ev.data) : 'ERR ' + ev.err);
  console.log('   take_snapshot  :', sn.ok ? 'OK ' + JSON.stringify(sn.data).slice(0, 80) : 'ERR ' + sn.err);
  await call('close_page', { pageId: p });
}
// and no-url default
const d = await call('new_page', {});
console.log('new_page({}) ->', JSON.stringify(d.data || d.err));
if (d.ok) {
  const ev = await call('evaluate_script', { pageId: d.data.pageId, function: '() => location.href' });
  console.log('   evaluate_script on default page:', ev.ok ? JSON.stringify(ev.data) : 'ERR ' + ev.err);
  await call('close_page', { pageId: d.data.pageId });
}
