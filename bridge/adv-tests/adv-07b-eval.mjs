// adv-07b-eval.mjs — follow-up: CDP-path args injection (fresh CSP page, no
// snapshot so checkUid is inert), chrome:// internal-page reach, and the
// promise-not-awaited asymmetry confirmation.
// Run: node adv-07b-eval.mjs
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let sid, i = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}${detail ? '\n        ' + detail : ''}`); };
const ok = (m) => console.log(`  PASS  ${m}`);

async function rpc(body, ms = 30000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!sid) sid = r.headers.get('mcp-session-id');
    const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
    return { msg: m.filter(Boolean).pop(), status: r.status, text };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msg: null }; }
  finally { clearTimeout(t); }
}
const call = (n, a, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }, ms);
function unwrap(r) {
  const m = r && r.msg; if (!m) return { isErr: true, err: 'NO-MSG ' + (r && r.text || '').slice(0, 160) };
  if (m.error) return { isErr: true, err: `RPC ${m.error.code}: ${m.error.message}` };
  const res = m.result; if (!res) return { isErr: true, err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 300) };
  let p; try { p = JSON.parse(txt); } catch { p = txt; }
  return { isErr: false, result: p && typeof p === 'object' && 'result' in p ? p.result : p, rawText: txt.slice(0, 300) };
}
const ev = (pageId, fn, extra = {}, ms = 30000) => call('evaluate_script', { pageId, function: fn, ...extra }, ms).then(unwrap);
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 180) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-eval-b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('session:', sid);

// ---- 1. chrome:// internal page ----
console.log('\n== chrome:// internal page ==');
{
  const np = unwrap(await call('new_page', { url: 'chrome://version/', background: false }));
  const cp = np.result && np.result.pageId;
  console.log('  chrome tab pageId:', cp);
  await sleep(900);
  const r = await ev(cp, '() => document.title + " | ver=" + (navigator.userAgent||"")');
  if (r.isErr) ok(`evaluate_script on chrome:// -> ERR ${tr(r.err, 160)} (blocked — page-only confirmed)`);
  else note('MED', 'evaluate_script ran on a chrome:// internal page', tr(r.result));
  // also try extension's own page
  await call('close_page', { pageId: cp }).catch(() => {});
}

// ---- 2. CDP-path args injection on a FRESH CSP page (no snapshot => checkUid inert) ----
console.log('\n== CDP-path args injection (fresh page, meta CSP, NO snapshot) ==');
{
  const np = unwrap(await call('new_page', { url: 'https://example.com', background: false }));
  const pageId = np.result && np.result.pageId;
  console.log('  pageId:', pageId);
  await sleep(1100);
  // NO take_snapshot — frameMaps has no entry -> checkUid(args[0]) returns undefined (inert).
  // Inject meta CSP so MAIN-world (0,eval) is refused -> CDP Runtime.evaluate fallback.
  const m = await ev(pageId, `() => { const m=document.createElement('meta'); m.httpEquiv='Content-Security-Policy'; m.content="script-src 'none'"; document.head.appendChild(m); return 'csp-on'; }`);
  ok(`meta CSP -> ${tr(m.result ?? m.err)}`);
  await sleep(250);
  // Crafted uid: completes the querySelector literal, then injects an expression.
  // elsExpr becomes: document.querySelector('[data-mcp-uid="x"]')+(window.__inj='CDP-INJECTED')+('"]')
  const injUid = `x"]')+(window.__inj='CDP-INJECTED')+('`;
  const r = await ev(pageId, '(a) => "fnsrc-ran,arg=" + typeof a', { args: [injUid] }, 20000);
  ok(`injection call -> ${r.isErr ? 'ERR ' + tr(r.err, 160) : tr(r.result)}`);
  const chk = await ev(pageId, '() => window.__inj', {}, 20000);
  if (S(chk.result) === '"CDP-INJECTED"' || chk.result === 'CDP-INJECTED')
    note('MED', 'args[] interpolated into CDP Runtime.evaluate -> arbitrary JS injection', 'crafted uid escaped the querySelector string literal and executed its own expression. Same trust domain as fnSrc, but args are unsanitised → injection/parse-error DoS surface (snapshot.js:152-153).');
  else ok(`injection marker window.__inj -> ${tr(chk.result)} (injection did NOT fire)`);
  // Malformed arg that only breaks the expression (parse-error DoS)
  const r2 = await ev(pageId, '() => "still-ran"', { args: [`a');var z=1;//`] }, 20000);
  ok(`parse-breaking arg -> ${r2.isErr ? 'ERR ' + tr(r2.err, 140) : tr(r2.result)}`);
  await call('detach_debugger', { pageId }).catch(() => {});
  await call('close_page', { pageId }).catch(() => {});
}

// ---- 3. promise-not-awaited: confirm via side-channel flag ----
console.log('\n== Promise await asymmetry (MAIN vs CDP) ==');
{
  const np = unwrap(await call('new_page', { url: 'https://example.com', background: false }));
  const pageId = np.result && np.result.pageId;
  await sleep(1100);
  // MAIN path: return value is the Promise object -> {} immediately; set flag to prove resolution.
  const r = await ev(pageId, `() => { window.__p='pending'; const pr=new Promise(res=>setTimeout(()=>{window.__p='resolved-late';res(99)},400)); return pr; }`);
  ok(`MAIN-path promise call -> ${tr(r.result)} [returned value serialized, not awaited]`);
  await sleep(700);
  const flag = await ev(pageId, '() => window.__p');
  ok(`async side-effect flag -> ${tr(flag.result)} (promise DID run in page; caller just never sees the value)`);
  await call('close_page', { pageId }).catch(() => {});
}

console.log('\n================ FINDINGS ================');
for (const f of findings) console.log(`  [${f.sev}] ${f.title}`);
console.log(`${findings.length} findings`);
process.exitCode = 0;
