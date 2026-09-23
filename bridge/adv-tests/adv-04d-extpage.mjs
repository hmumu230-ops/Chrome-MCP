// adv-04d: does scripting run inside a tab navigated to the extension's own origin?
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, rpcId = 0;
const mine = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function req(m, p) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: m, params: p }) });
  if (r.headers.get('mcp-session-id')) sid = r.headers.get('mcp-session-id');
  const t = await r.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return { status: r.status, body: JSON.parse(dl || t) }; } catch { return { status: r.status, body: { raw: t } }; }
}
async function init() { sid = null; await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv04d', version: '0' } }); if (!sid) throw new Error('no sid'); }
async function call(n, a, tries = 8) {
  for (let i = 0; i < tries; i++) {
    let r; try { r = await req('tools/call', { name: n, arguments: a }); } catch { await sleep(800); continue; }
    const res = r.body.result;
    if (res) { const tx = (res.content || []).map(c => c.text || '').join('\n'); if (res.isError && /timeout|disconnected|not connected/i.test(tx) && i < tries - 1) { await sleep(700); continue; } return { isError: !!res.isError, text: tx }; }
    if ((r.status === 503 || r.status === 404) && i < tries - 1) { await init().catch(() => {}); await sleep(500); continue; }
    return { isError: true, text: `HTTP ${r.status}` };
  }
  return { isError: true, text: 'retries exhausted' };
}
async function closeTab(id) { if (!mine.has(id)) return; mine.delete(id); await call('close_page', { pageId: id }); }

await init();
const np = await call('new_page', { url: 'about:blank', background: true });
const id = +(np.text.match(/\d{6,}/) || [0])[0];
if (id) mine.add(id);
console.log('tab', id);
const nav = await call('navigate_page', { pageId: id, type: 'url', url: 'chrome-extension://pmhfdkkgjbfngeekdbdnjdnlnhmbinoh/popup.html' });
console.log('nav ext popup:', nav.text.slice(0, 220));
await sleep(900);
const ev = await call('evaluate_script', { pageId: id, function: '() => ({ hasChrome: typeof chrome !== "undefined", hasTabs: !!(typeof chrome!=="undefined" && chrome.tabs), url: location.href })' });
console.log('eval on ext page:', ev.text.slice(0, 500));
const ev2 = await call('evaluate_script', { pageId: id, function: '() => (typeof chrome!=="undefined" && chrome.cookies) ? "COOKIES-API-PRESENT" : "no-cookie-api"' });
console.log('cookie api probe:', ev2.text.slice(0, 300));
const sn = await call('take_snapshot', { pageId: id });
console.log('snapshot on ext page:', sn.text.slice(0, 300));
// same trick on chrome://settings — scripting must fail there
const nav2 = await call('navigate_page', { pageId: id, type: 'url', url: 'chrome://settings' });
console.log('nav chrome settings:', nav2.text.slice(0, 160));
await sleep(900);
const ev3 = await call('evaluate_script', { pageId: id, function: '() => 1+1' });
console.log('eval on chrome://:', ev3.text.slice(0, 300));
await closeTab(id);
for (const t of [...mine]) await closeTab(t);
console.log('DONE');
process.exit(0);
