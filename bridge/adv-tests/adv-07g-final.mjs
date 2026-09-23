// adv-07g-final.mjs — cleanup my leftover tabs (301370968, 301370970) +
// finish: http-origin POST to bridge (armed after load), abort/late-response
// check with distinct ids.
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let sid = null, i = 0;
const MY = new Set([301370968, 301370970]);

async function rpc(body, ms = 30000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  const id = body.id;
  try {
    const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); if (!sid) sid = r.headers.get('mcp-session-id');
    const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return { msgs, status: r.status, text, wantId: id };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msgs: [] }; }
  finally { clearTimeout(t); }
}
async function call(n, a, ms = 30000) {
  const id = ++i;
  const r = await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a } }, ms);
  const mine = r.msgs.find(m => m.id === id);
  const stale = r.msgs.filter(m => m.id !== undefined && m.id !== id);
  if (stale.length) console.log(`  !! stale piggyback on req ${id}: ids ${stale.map(m => m.id).join(',')}`);
  const m = mine || r.msgs[r.msgs.length - 1];
  if (!m) return { isErr: true, err: 'NO-MSG ' + (r.text || '').slice(0, 120) };
  const res = m.result; if (!res) return { isErr: true, err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 300) };
  let p; try { p = JSON.parse(txt); } catch { p = txt; }
  return { isErr: false, result: p && typeof p === 'object' && 'result' in p ? p.result : p };
}
const ev = (pageId, fn, extra = {}, ms = 30000) => call('evaluate_script', { pageId, function: fn, ...extra }, ms);
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 180) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };
const R = (r) => r.isErr ? 'ERR ' + tr(r.err, 200) : tr(r.result, 200);

for (let attempt = 0; attempt < 25; attempt++) {
  const ir = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv07g', version: '0' } } }, 15000);
  if (ir.status !== 200) { console.log(`init attempt ${attempt}: status ${ir.status}`); await sleep(4000); continue; }
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const lp = await call('list_pages', {}, 15000);
  if (lp.isErr) { console.log(`init attempt ${attempt}: ${lp.err.slice(0, 80)}`); await sleep(4000); continue; }
  const tabs = lp.result;
  console.log(`connected. tabs=${tabs.length}`);
  // finish the http->bridge check on my http tab if still alive
  const httpTab = tabs.find(t => t.pageId === 301370970);
  if (httpTab) {
    const arm = await ev(301370970, `() => { window.__b='pending'; fetch('http://127.0.0.1:7890/mcp',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}).then(r=>r.text()).then(t=>window.__b='OK '+t.slice(0,140)).catch(e=>window.__b='ERR '+e.message); return 'armed'; }`, {}, 15000);
    console.log('  arm fetch ->', R(arm));
    await sleep(1800);
    const b = await ev(301370970, '() => window.__b', {}, 15000);
    console.log('  POST /mcp from http page ->', tr(b.result, 220));
  }
  // abort/late-response check on my example tab if alive
  const exTab = tabs.find(t => t.pageId === 301370968);
  if (exTab) {
    const slowP = ev(301370968, 'async () => { await new Promise(r=>setTimeout(r,4000)); return "SLOW-LATE" }', {}, 1500);
    await sleep(1800);
    const fast = await ev(301370968, '() => "FAST"', {}, 12000);
    console.log('  fast call during pending slow ->', R(fast));
    const slow = await slowP;
    console.log('  slow aborted call ->', R(slow));
  }
  // close my leftovers
  for (const t of tabs) {
    if (!MY.has(t.pageId)) continue;
    const c = await call('close_page', { pageId: t.pageId }, 15000);
    console.log(`  closed ${t.pageId} ${String(t.url).slice(0, 45)} -> ${c.isErr ? 'ERR ' + c.err.slice(0, 80) : JSON.stringify(c.result).slice(0, 60)}`);
  }
  // verify
  const lp2 = await call('list_pages', {}, 15000);
  const left = (lp2.result || []).filter(t => MY.has(t.pageId));
  console.log('  remaining mine:', left.map(t => t.pageId).join(',') || 'none');
  process.exit(0);
}
console.log('could not get a stable window in 25 tries');
process.exit(1);
