// adv-07f-eval.mjs — remaining checks: frameId param, malformed function arg,
// concurrent evals, http-origin page POSTing to the bridge, and a clean check
// of whether an aborted call's late response leaks into the next response.
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let sid = null, i = 0;
const myTabs = new Set();

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
async function call(n, a, ms) {
  const id = ++i;
  const r = await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a } }, ms);
  // pick the message matching OUR request id — ignore stale cross-delivered ones
  const mine = r.msgs.find(m => m.id === id);
  const stale = r.msgs.filter(m => m.id !== undefined && m.id !== id);
  if (stale.length) console.log(`  !! stale response(s) piggybacked on req ${id}: ${stale.map(m => 'id=' + m.id).join(',')}`);
  const m = mine || r.msgs[r.msgs.length - 1];
  if (!m) return { isErr: true, err: 'NO-MSG ' + (r.text || '').slice(0, 120) };
  if (m.error) return { isErr: true, err: `RPC ${m.error.code}: ${m.error.message}` };
  const res = m.result; if (!res) return { isErr: true, err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 300) };
  let p; try { p = JSON.parse(txt); } catch { p = txt; }
  return { isErr: false, result: p && typeof p === 'object' && 'result' in p ? p.result : p };
}
const ev = (pageId, fn, extra = {}) => call('evaluate_script', { pageId, function: fn, ...extra }, (extra && extra.ms) || 30000);
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 160) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };
const R = (r) => r.isErr ? 'ERR ' + tr(r.err, 200) : tr(r.result, 200);

const init = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv07f', version: '0' } } });
console.log('init:', init.status);
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const np = await call('new_page', { url: 'https://example.com' });
const A = np.result && np.result.pageId;
console.log('tabA:', A, R(np));
if (!A) { console.log('no tab — abort'); process.exit(1); }
myTabs.add(A);
await sleep(1400);
console.log('ready:', R(await ev(A, '() => document.readyState')));

console.log('\n== frameId param ==');
console.log('  frameId:0       ->', R(await ev(A, '() => 1', { frameId: 0 })));
console.log('  frameId:999999  ->', R(await ev(A, '() => 1', { frameId: 999999 })));
console.log('  frameId:-1      ->', R(await ev(A, '() => 1', { frameId: -1 })));
console.log('  frameId:"0;injection" ->', R(await ev(A, '() => 1', { frameId: '0;alert(1)' })));

console.log('\n== malformed function arg ==');
console.log('  empty ""        ->', R(await ev(A, '')));
console.log('  missing         ->', R(await call('evaluate_script', { pageId: A })));
console.log('  number 42       ->', R(await call('evaluate_script', { pageId: A, function: 42 })));
console.log('  null            ->', R(await call('evaluate_script', { pageId: A, function: null })));
console.log('  "()"            ->', R(await ev(A, '()')));
console.log('  object          ->', R(await call('evaluate_script', { pageId: A, function: { x: 1 } })));

console.log('\n== concurrent evals same tab ==');
{
  const [c1, c2, c3] = await Promise.all([
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c1" }'),
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c2" }'),
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c3" }'),
  ]);
  console.log(`  c1=${S(c1.result ?? c1.err)} c2=${S(c2.result ?? c2.err)} c3=${S(c3.result ?? c3.err)}`);
}

console.log('\n== http page -> bridge reach (no mixed-content shield on http) ==');
{
  const H2 = await call('new_page', { url: 'http://example.com' });
  const h2 = H2.result && H2.result.pageId;
  console.log('  http tab:', h2, R(H2));
  if (h2) {
    myTabs.add(h2);
    await sleep(1400);
    await ev(h2, `() => { window.__b='p'; fetch('http://127.0.0.1:7890/mcp',{method:'POST',headers:{'content-type':'text/plain'},body:'{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}'}).then(r=>r.text()).then(t=>window.__b='OK '+t.slice(0,140)).catch(e=>window.__b='ERR '+e.message); return 'a'; }`);
    await sleep(1500);
    const b = await ev(h2, '() => window.__b');
    console.log('  POST /mcp (simple req, Origin http://example.com) ->', tr(b.result, 200));
  }
}

console.log('\n== aborted-call late response (clean check, distinct ids) ==');
{
  // fire a slow eval, abort client-side at 1.5s, then a fast call on the same session
  const slowP = ev(A, 'async () => { await new Promise(r=>setTimeout(r,4000)); return "SLOW-LATE" }', 1500);
  await sleep(1800);
  const fast = await ev(A, '() => "FAST"', 10000);
  console.log('  fast call after abort ->', R(fast));
  const slow = await slowP;
  console.log('  aborted slow call (client view) ->', R(slow));
}

console.log('\n== cleanup ==');
const lp = await call('list_pages', {});
for (const t of (lp.result || []).filter(t => myTabs.has(t.pageId))) {
  const c = await call('close_page', { pageId: t.pageId });
  console.log(`  closed ${t.pageId} ${String(t.url).slice(0, 50)} -> ${c.err || JSON.stringify(c.data).slice(0, 60)}`);
}
console.log('done');
