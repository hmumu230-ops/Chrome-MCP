// adv-07e-eval.mjs — follow-ups: where does deep-nesting truncate, thenable
// assimilation, while(1) fresh-tab hang check, bogus frameId, http-origin
// fetch to the bridge, concurrent evals.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
const EXT_ID = fs.readFileSync('D:/Tool/chrome-mcp/bridge/.extension-id', 'utf8').trim().replace('chrome-extension://', '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let sid, i = 0;
const findings = [];
const note = (sev, t, d) => { findings.push({ sev, t }); console.log(`  [${sev}] ${t}${d ? '\n        ' + d : ''}`); };
const ok = (m) => console.log(`  PASS  ${m}`);
const myTabs = new Set();

async function rpc(body, ms = 30000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); if (!sid) sid = r.headers.get('mcp-session-id');
    const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
    return { msg: m.filter(Boolean).pop(), status: r.status, text };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msg: null }; }
  finally { clearTimeout(t); }
}
const call = (n, a, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }, ms);
function unwrap(r) {
  const m = r && r.msg; if (!m) return { isErr: true, err: 'NO-MSG ' + (r && r.text || '').slice(0, 160), text: r && r.text };
  if (m.error) return { isErr: true, err: `RPC ${m.error.code}: ${m.error.message}` };
  const res = m.result; if (!res) return { isErr: true, err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 400), text: txt };
  let p; try { p = JSON.parse(txt); } catch { p = txt; }
  return { isErr: false, result: p && typeof p === 'object' && 'result' in p ? p.result : p, text: txt };
}
const ev = (pageId, fn, extra = {}) => call('evaluate_script', { pageId, function: fn, ...extra }, extra.ms || 30000).then(unwrap);
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 160) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };
const R = (r) => r.isErr ? 'ERR ' + tr(r.err, 200) : tr(r.result, 200);

const init = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv07e', version: '0' } } });
console.log('init:', init.status);
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const np = unwrap(await call('new_page', { url: 'https://example.com' }));
const A = np.result.pageId; myTabs.add(A);
await sleep(1500);
console.log('tabA:', A, R(await ev(A, '() => document.readyState')));

// ---- 1. depth truncation: where does it happen?
console.log('\n== depth truncation ==');
for (const d of [50, 98, 99, 100, 120, 200, 500]) {
  const r = await ev(A, `() => { let o={leaf:1}; for(let i=0;i<${d};i++) o={next:o}; return o }`);
  let depth = -1;
  if (!r.isErr) { depth = 0; let c = r.result; while (c && c.next) { depth++; c = c.next; } }
  console.log(`  sent ${d} -> ${r.isErr ? 'ERR ' + tr(r.err, 100) : 'measured depth ' + depth}`);
}
// stringify IN page bypasses object transport entirely:
const sj = await ev(A, '() => { let o={leaf:1}; for(let i=0;i<500;i++) o={next:o}; const s=JSON.stringify(o); return {len:s.length, tail:s.slice(-30)} }');
ok(`in-page JSON.stringify(500) -> ${tr(sj.result, 120)} (page side fine; truncation is in Chrome result transport)`);
// where exactly does the cut happen — what does the last level look like?
const dl = await ev(A, '() => { let o={leaf:1}; for(let i=0;i<500;i++) o={next:o,m:i}; return o }');
{
  let c = dl.result, n = 0; while (c && c.next) { n++; c = c.next; }
  console.log('  last surviving level:', tr(c, 120), '| depth', n);
}

// ---- 2. thenable assimilation
console.log('\n== thenable assimilation ==');
const th1 = await ev(A, '() => ({then(res){res("THENABLE-UNWRAPPED")}})');
ok(`return {then(res){res(...)}} -> ${R(th1)}`);
const th2 = await ev(A, '() => ({then: 42})');
ok(`return {then:42} (non-callable) -> ${R(th2)}`);
const th3 = await ev(A, '() => ({then(){throw new Error("THEN-THROW")}})');
ok(`return {then(){throw}} -> ${R(th3)}`);

// ---- 3. while(1) on a FRESH tab (isolated check)
console.log('\n== infinite loop, fresh tab ==');
{
  const H = unwrap(await call('new_page', { url: 'https://example.com' })).result.pageId; myTabs.add(H);
  await sleep(1200);
  const t0 = Date.now();
  const lr = await ev(H, '() => { while(1){} }', { ms: 12000 });
  const dt = Date.now() - t0;
  console.log(`  while(1) -> ${R(lr)} after ${dt}ms`);
  if (dt >= 11000) note('MED', 'infinite-loop script wedges the call (no per-script timeout)', `${dt}ms`);
  // probe: is the tab's renderer alive?
  const pr = await ev(H, '() => 1', { ms: 5000 });
  console.log('  probe after loop:', R(pr));
  const c = unwrap(await call('close_page', { pageId: H })); myTabs.delete(H);
  ok(`close looped tab -> ${tr(c.result ?? c.err, 80)}`);
}

// ---- 4. frameId handling
console.log('\n== frameId param ==');
const f0 = await ev(A, '() => 1', { frameId: 0 });
ok(`frameId:0 -> ${R(f0)}`);
const fBog = await ev(A, '() => 1', { frameId: 999999 });
ok(`frameId:999999 -> ${R(fBog)}`);
const fNeg = await ev(A, '() => 1', { frameId: -1 });
ok(`frameId:-1 -> ${R(fNeg)}`);
const fStr = await ev(A, '() => 1', { frameId: '0;alert(1)' });
ok(`frameId:"0;alert(1)" -> ${R(fStr)}`);

// ---- 5. http-origin page can reach the bridge? (no mixed-content shield)
console.log('\n== http page -> bridge reach ==');
{
  const H2 = unwrap(await call('new_page', { url: 'http://example.com' })).result.pageId; myTabs.add(H2);
  await sleep(1500);
  await ev(H2, `() => { window.__b='p'; fetch('http://127.0.0.1:7890/mcp',{method:'POST',headers:{'content-type':'text/plain'},body:'{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}'}).then(r=>r.text()).then(t=>window.__b='OK '+t.slice(0,140)).catch(e=>window.__b='ERR '+e.message); return 'a'; }`);
  await ev(H2, `() => { window.__g='p'; fetch('http://127.0.0.1:7890/').then(r=>r.text()).then(t=>window.__g='OK '+t.slice(0,140)).catch(e=>window.__g='ERR '+e.message); return 'a'; }`);
  await sleep(1500);
  const b = await ev(H2, '() => window.__b');
  const g = await ev(H2, '() => window.__g');
  console.log('  POST /mcp text/plain from http page ->', tr(b.result, 200));
  console.log('  GET / status from http page ->', tr(g.result, 200));
  // NOTE: even if the request hits the server, Origin: http://example.com is
  // rejected by httpAccessError before routing — tool never executes.
}

// ---- 6. concurrent evals on same tab
console.log('\n== concurrent evals ==');
{
  const [c1, c2, c3] = await Promise.all([
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c1" }'),
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c2" }'),
    ev(A, 'async () => { await new Promise(r=>setTimeout(r,300)); return "c3" }'),
  ]);
  ok(`3 parallel evals -> ${S(c1.result)}/${S(c2.result)}/${S(c3.result)}${c1.isErr || c2.isErr || c3.isErr ? ' ERRs:' + [c1.err, c2.err, c3.err].filter(Boolean).join(';') : ''}`);
}

// ---- 7. empty/missing function arg
console.log('\n== malformed function arg ==');
ok(`empty string -> ${R(await ev(A, ''))}`);
ok(`missing function -> ${R(unwrap(await call('evaluate_script', { pageId: A })))}`);
ok(`number -> ${R(unwrap(await call('evaluate_script', { pageId: A, function: 42 })))}`);

// ---- cleanup
console.log('\n== cleanup ==');
const lpEnd = unwrap(await call('list_pages', {}));
for (const t of (lpEnd.result || []).filter(t => myTabs.has(t.pageId))) {
  const c = unwrap(await call('close_page', { pageId: t.pageId }));
  console.log(`  closed ${t.pageId} ${tr(t.url, 50)} -> ${tr(c.result ?? c.err, 60)}`);
}
console.log('\n== FINDINGS ==');
for (const f of findings) console.log(`  [${f.sev}] ${f.t}`);
if (!findings.length) console.log('(none)');
process.exitCode = 0;
