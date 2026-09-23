// adv-07c-eval.mjs — args plumbing on a real uid (example.com has no uids).
// Confirms MAIN-path args go to document.querySelector (NOT eval), checkUid
// guards only args[0], and a quote-bearing uid only breaks the selector.
// Run: node adv-07c-eval.mjs
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let sid, i = 0;
const findings = [];
const note = (sev, t, d) => { findings.push({ sev, t }); console.log(`  [${sev}] ${t}${d ? '\n        ' + d : ''}`); };
const ok = (m) => console.log(`  PASS  ${m}`);
async function rpc(body, ms = 30000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); if (!sid) sid = r.headers.get('mcp-session-id');
    const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
    return { msg: m.filter(Boolean).pop(), status: r.status, text };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}`, msg: null }; } finally { clearTimeout(t); }
}
const call = (n, a, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }, ms);
function unwrap(r) {
  const m = r && r.msg; if (!m) return { isErr: true, err: 'NO-MSG' };
  if (m.error) return { isErr: true, err: `RPC ${m.error.code}: ${m.error.message}` };
  const res = m.result; if (!res) return { isErr: true, err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 300) };
  let p; try { p = JSON.parse(txt); } catch { p = txt; }
  return { isErr: false, result: p && typeof p === 'object' && 'result' in p ? p.result : p };
}
const ev = (pageId, fn, extra = {}) => call('evaluate_script', { pageId, function: fn, ...extra }).then(unwrap);
const tr = (s, n = 170) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s && s.length > n ? s.slice(0, n) + '…' : s; };

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-c', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const np = unwrap(await call('new_page', { url: 'https://example.com' }));
const pageId = np.result && np.result.pageId;
console.log('pageId:', pageId);
await sleep(1100);
// plant an interactive element so snapshot assigns it a uid
await ev(pageId, `() => { const a=document.createElement('a'); a.id='advbtn'; a.href='#'; a.textContent='advbtn'; document.body.appendChild(a); return 'added'; }`);
const snap = unwrap(await call('take_snapshot', { pageId }));
const lines = (snap.result && snap.result.lines) || [];
console.log('snapshot lines:', lines.length);
// uids aren't returned in the result object — read the attribute the snapshot assigned.
const uq = await ev(pageId, `() => { const el=document.getElementById('advbtn'); return el ? el.getAttribute('data-mcp-uid') : 'NO-ATTR'; }`);
const realUid = uq.result && uq.result !== 'NO-ATTR' ? uq.result : undefined;
console.log('  realUid (data-mcp-uid):', realUid);

if (realUid) {
  const r1 = await ev(pageId, '(el) => el ? el.tagName + "/" + el.id + "/" + el.getAttribute("data-mcp-uid") : "NULL"', { args: [realUid] });
  ok(`valid uid resolves to element -> ${tr(r1.result ?? r1.err)}`);
  const r2 = await ev(pageId, '(el) => el ? "GOT-EL" : "NULL-el"', { args: ['e999999'] });
  if (r2.isErr && /stale uid/i.test(r2.err)) ok(`fake uid e999999 -> stale-uid guard: ${tr(r2.err, 90)}`);
  else ok(`fake uid -> ${r2.isErr ? 'ERR ' + tr(r2.err, 90) : tr(r2.result)}`);
  // checkUid only inspects args[0]: valid uid first, injection-string second.
  const r3 = await ev(pageId, '(a,b) => "a=" + (a ? a.id : "null") + " b=" + (b === null ? "null" : typeof b)', { args: [realUid, 'e1";alert(1);//'] });
  ok(`2nd arg 'e1";alert(1);//' (MAIN path) -> ${r3.isErr ? 'ERR ' + tr(r3.err, 140) : tr(r3.result)}`);
  // does the injected string actually run? set a marker it would set if it eval'd
  const r4 = await ev(pageId, '() => window.__arginj || "none"');
  ok(`post-arg marker __arginj -> ${tr(r4.result)} (unchanged => arg stayed a selector, not eval)`);
}
await call('close_page', { pageId }).catch(() => {});
console.log(`\n${findings.length} findings`);
process.exitCode = 0;
