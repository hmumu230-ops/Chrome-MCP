// adv-12b: uid staleness across navigation — focused retest on a scriptable page.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async (b) => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return m[m.length - 1];
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v3', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => {
  const m = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const res = m && m.result;
  if (!res) return { ok: 0, err: 'nores ' + JSON.stringify(m && m.error) };
  const tx = (res.content && res.content[0] && res.content[0].text) || '';
  if (res.isError) return { ok: 0, err: tx };
  try { return { ok: 1, data: JSON.parse(tx) }; } catch { return { ok: 1, data: res.structuredContent || tx }; }
};

const p = (await call('new_page', { url: 'http://127.0.0.1:7890/', background: true })).data.pageId;
console.log('tab', p);
await new Promise(r => setTimeout(r, 800));

const ev = await call('evaluate_script', { pageId: p, function: "() => { document.body.innerHTML = '<button id=b>old</button>'; return 1 }" });
console.log('inject:', JSON.stringify(ev.data || ev.err));
const s = await call('take_snapshot', { pageId: p });
console.log('snapshot lines:', s.ok ? JSON.stringify(s.data.lines) : s.err);
const uid = s.ok && s.data.lines && s.data.lines.length ? (s.data.lines.join('\n').match(/\[(e\d+)\]/) || [])[1] : null;
console.log('uid =', uid);
if (uid) {
  const c = await call('click', { pageId: p, uid });
  console.log('baseline click:', c.ok ? 'OK ' + JSON.stringify(c.data).slice(0, 60) : 'ERR ' + c.err);
}
const n1 = await call('navigate_page', { pageId: p, url: 'chrome://newtab' });
console.log('nav -> chrome://newtab:', n1.ok ? JSON.stringify(n1.data) : n1.err);
const n2 = await call('navigate_page', { pageId: p, url: 'http://127.0.0.1:7890/' });
console.log('nav -> back:', n2.ok ? JSON.stringify(n2.data) : n2.err);
await new Promise(r => setTimeout(r, 600));
if (uid) {
  const cOld = await call('click', { pageId: p, uid });
  console.log('click OLD uid (no fresh snapshot):', cOld.ok ? 'OK ' + JSON.stringify(cOld.data).slice(0, 60) : 'ERR ' + cOld.err);
}
// inject a DIFFERENT element; fresh snapshot reassigns uids from e1 — does the
// OLD uid then silently click the NEW element?
const ev2 = await call('evaluate_script', { pageId: p, function: "() => { document.body.innerHTML = '<button id=n onclick=\"document.title=77\">NEW</button>'; return 1 }" });
console.log('inject2:', JSON.stringify(ev2.data || ev2.err));
const s2 = await call('take_snapshot', { pageId: p });
console.log('snapshot2 lines:', s2.ok ? JSON.stringify(s2.data.lines) : s2.err);
if (uid) {
  const cOld2 = await call('click', { pageId: p, uid });
  console.log('click OLD uid after fresh snapshot:', cOld2.ok ? 'OK ' + JSON.stringify(cOld2.data).slice(0, 80) : 'ERR ' + cOld2.err);
  const t = await call('evaluate_script', { pageId: p, function: '() => document.title' });
  console.log('document.title after click:', JSON.stringify(t.data), '(77 = NEW element clicked by stale uid)');
}
await call('close_page', { pageId: p });
console.log('closed', p);
