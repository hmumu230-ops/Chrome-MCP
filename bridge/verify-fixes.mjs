const BASE = 'http://127.0.0.1:7890/mcp'; let sid = null, idc = 0;
async function call(name, args) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const method = name === 'initialize' ? 'initialize' : 'tools/call';
  const params = method === 'initialize' ? args : { name, arguments: args };
  const res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  const j = JSON.parse(dl || t); const r = j.result;
  if (r && r.isError) return { error: r.content[0].text };
  if (r && r.content && r.content[0] && r.content[0].text) { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } }
  return r || j;
}
await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'v', version: '0' } });
const np = await call('new_page', { url: 'https://example.com' });
const pid = np.pageId;
console.log('pageId', pid);
await call('evaluate_script', { pageId: pid, function: '() => { window.__n=0; const b=document.createElement("button"); b.textContent="Cnt"; b.onclick=()=>window.__n++; document.body.prepend(b); return "ok" }' });
await call('select_page', { pageId: pid, bringToFront: true });
await call('list_console_messages', { pageId: pid });
const snap = await call('take_snapshot', { pageId: pid });
const line = snap.lines.find(l => /Cnt/.test(l));
const uid = line.match(/\[((?:f\d+)?[a-z0-9]+e\d+)\]/)[1];
console.log('uid=', uid);
const clk = await call('click', { pageId: pid, uid, includeSnapshot: true });
console.log('click+snap:', JSON.stringify(clk).slice(0, 100));
const n = await call('evaluate_script', { pageId: pid, function: '() => window.__n' });
console.log('click count =', n.result, '(expect 1 — was 2 with double-click bug)');
const np2 = await call('new_page', { url: 'https://example.com', background: true });
const pk = await call('press_key', { pageId: np2.pageId, key: 'x' });
console.log('press_key bg tab:', JSON.stringify(pk).slice(0, 140));
const cp = await call('close_page', { pageId: [1, 2] });
console.log('close_page array:', JSON.stringify(cp).slice(0, 120));
const nv = await call('navigate_page', { pageId: pid, type: 'url', url: 'javascript:alert(1)' });
console.log('nav javascript:', JSON.stringify(nv).slice(0, 120));
// stale-uid across same-shaped navigation: snapshot e-uid, nav away+back to same page, reuse uid
const nv2 = await call('navigate_page', { pageId: pid, type: 'url', url: 'https://example.org' });
await call('navigate_page', { pageId: pid, type: 'url', url: 'https://example.com' });
const clk2 = await call('click', { pageId: pid, uid });
console.log('stale uid after nav:', JSON.stringify(clk2).slice(0, 120), '(expect stale/not-found error)');
await call('close_page', { pageId: np2.pageId });
await call('close_page', { pageId: pid });
