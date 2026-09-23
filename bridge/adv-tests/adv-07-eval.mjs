// adv-07-eval.mjs — adversarial scope test for evaluate_script.
// Question under test: does evaluate_script (MAIN-world eval) exceed PAGE
// privileges and touch extension/browser internals? Source: extension/handlers/
// snapshot.js:117-163 — chrome.scripting.executeScript({world:'MAIN'}) running
// (0,eval)('('+src+')'), with a chrome.debugger Runtime.evaluate fallback that
// bypasses page CSP and interpolates `args` into the evaluated expression.
// Run: node adv-07-eval.mjs
const BASE = 'http://127.0.0.1:7890/mcp';
const EXT_ID = 'pmhfdkkgjbfngeekdbdnjdnhmbinoh'; // from bridge/.extension-id
const OUT_DIR = 'D:/Tool/chrome-mcp/bridge/adv-tests';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let sid, i = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}${detail ? '\n        ' + detail : ''}`); };
const ok = (m) => console.log(`  PASS  ${m}`);

async function rpc(body, ms = 30000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!sid) sid = r.headers.get('mcp-session-id');
    const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
    return { msg: m.filter(Boolean).pop(), status: r.status, text };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msg: null }; }
  finally { clearTimeout(t); }
}
const call = (n, a, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }, ms);

// Unwrap a tools/call result -> {isErr, err, result, raw}
function unwrap(r) {
  const m = r && r.msg;
  if (!m) return { isErr: true, err: 'NO-MSG ' + (r && r.text || '').slice(0, 160), raw: r };
  if (m.error) return { isErr: true, err: `RPC ${m.error.code}: ${m.error.message}`, raw: m };
  const res = m.result;
  if (!res) return { isErr: true, err: 'NO-RESULT', raw: m };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { isErr: true, err: txt.replace(/^Error:\s*/, '').slice(0, 300), raw: res };
  // text is JSON.stringify of the data object ({result: v})
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  const v = parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed;
  return { isErr: false, result: v, rawText: txt.slice(0, 400), raw: res };
}
// Run evaluate_script; returns {isErr,err,result,ms,rawText}
async function ev(pageId, fn, { args, dialogAction, filePath, ms = 30000, frameId } = {}) {
  const t0 = Date.now();
  const a = { pageId, function: fn };
  if (args) a.args = args;
  if (dialogAction !== undefined) a.dialogAction = dialogAction;
  if (filePath) a.filePath = filePath;
  if (frameId !== undefined) a.frameId = frameId;
  const r = await call('evaluate_script', a, ms);
  const u = unwrap(r);
  return { ...u, ms: Date.now() - t0 };
}
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 160) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };

// =================================================================
const _init = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-eval', version: '0' } } });
console.log('init status', _init.status, '| sid-header?', sid, '| body', ( _init.text||'').slice(0,200));
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('session:', sid);

// Fresh page.
const np = unwrap(await call('new_page', { url: 'https://example.com', background: false }));
const pageId = np.result && np.result.pageId;
console.log('pageId:', pageId);
if (!pageId) { console.log('FATAL: no pageId — aborting'); process.exit(1); }
await sleep(1200);
const sanity = await ev(pageId, '() => document.title + " | " + location.origin');
console.log('sanity:', tr(sanity.result ?? sanity.err));

// =================================================================
console.log('\n== A. extension/browser-privilege reachability ==');
{
  const t = await ev(pageId, '() => typeof chrome');
  ok(`typeof chrome = ${S(t.result)}`);
  const keys = await ev(pageId, '() => window.chrome ? Object.keys(window.chrome) : []');
  ok(`window.chrome keys = ${tr(keys.result)}`);
  for (const [label, expr] of [
    ['chrome.debugger', '() => typeof chrome.debugger'],
    ['chrome.scripting', '() => typeof chrome.scripting'],
    ['chrome.tabs', '() => typeof chrome.tabs'],
    ['chrome.cookies', '() => typeof chrome.cookies'],
    ['chrome.webNavigation', '() => typeof chrome.webNavigation'],
    ['chrome.runtime', '() => typeof chrome.runtime'],
    ['chrome.runtime.sendMessage', '() => chrome.runtime ? typeof chrome.runtime.sendMessage : "no-runtime"'],
    ['chrome keys on window', '() => Object.keys(window).filter(k => /^chrome/i.test(k))'],
  ]) {
    const r = await ev(pageId, expr);
    ok(`${label} -> ${tr(r.result ?? ('ERR:' + r.err))}`);
  }

  // Can page JS reach the extension via runtime.sendMessage?
  await ev(pageId, `() => { window.__sm='pending'; try { const p = chrome.runtime.sendMessage('${EXT_ID}', {type:'status'}, (r) => { window.__sm = chrome.runtime.lastError ? ('lastError:' + chrome.runtime.lastError.message) : ('RESP:' + JSON.stringify(r)); }); window.__sm = window.__sm === 'pending' ? ('returned:' + typeof p) : window.__sm; } catch(e) { window.__sm = 'threw:' + e.message; } return 'armed'; }`);
  await sleep(600);
  const sm = await ev(pageId, '() => window.__sm');
  if (/RESP:/.test(S(sm.result))) note('CRITICAL', 'page reached extension via chrome.runtime.sendMessage', sm.result);
  else ok(`sendMessage to ext -> ${tr(sm.result)} (no externally_connectable: blocked)`);
}

// =================================================================
console.log('\n== B. scheme / network reach from page context ==');
{
  await ev(pageId, `() => { window.__f='pending'; fetch('file:///C:/Windows/win.ini').then(r=>r.text()).then(t=>window.__f='OK len='+t.length+' '+JSON.stringify(t.slice(0,40))).catch(e=>window.__f='ERR '+e.name+': '+e.message); return 'armed'; }`);
  await ev(pageId, `() => { window.__c='pending'; fetch('chrome://version/').then(r=>r.text()).then(t=>window.__c='OK len='+t.length).catch(e=>window.__c='ERR '+e.name+': '+e.message); return 'armed'; }`);
  await ev(pageId, `() => { window.__i='pending'; if(!indexedDB.databases){window.__i='no indexedDB.databases'} else indexedDB.databases().then(d=>window.__i='OK '+JSON.stringify(d.map(x=>x.name))).catch(e=>window.__i='ERR '+e.name+': '+e.message); return 'armed'; }`);
  await ev(pageId, `() => { window.__mcp='pending'; fetch('http://127.0.0.1:7890/').then(r=>r.text()).then(t=>window.__mcp='OK '+t.slice(0,80)).catch(e=>window.__mcp='ERR '+e.name+': '+e.message); return 'armed'; }`);
  await sleep(1500);
  for (const [label, g] of [['fetch file:///C:/Windows/win.ini', '__f'], ['fetch chrome://version', '__c'], ['indexedDB.databases()', '__i'], ['fetch 127.0.0.1:7890 (bridge, CORS)', '__mcp']]) {
    const r = await ev(pageId, `() => window.${g}`);
    if (/OK/.test(S(r.result))) note('MED', `${label} succeeded from page`, r.result);
    else ok(`${label} -> ${tr(r.result)}`);
  }
}

// =================================================================
console.log('\n== C. SOP / storage / opener ==');
{
  await ev(pageId, `() => { window.__xo='pending'; const f=document.createElement('iframe'); f.src='https://example.org/'; f.onload=()=>{ try { window.__xo='cookie:' + JSON.stringify(f.contentDocument.cookie); } catch(e){ window.__xo='SOP ' + e.name + ': ' + String(e.message).slice(0,80); } }; document.body.appendChild(f); return 'armed'; }`);
  await sleep(1800);
  const xo = await ev(pageId, '() => window.__xo');
  ok(`cross-origin iframe cookie -> ${tr(xo.result)}`);
  const op = await ev(pageId, '() => String(window.opener)');
  ok(`window.opener -> ${tr(op.result)}`);
  const ls = await ev(pageId, `() => { localStorage.setItem('__adv','1'); return localStorage.getItem('__adv') + ' len=' + localStorage.length; }`);
  ok(`localStorage (page-level) -> ${tr(ls.result)}`);
  const dc = await ev(pageId, '() => JSON.stringify(document.cookie)');
  ok(`document.cookie -> ${tr(dc.result)}`);
}

// =================================================================
console.log('\n== D. return-value serialization bombs ==');
{
  const cases = [
    ['number', '() => 42'],
    ['object', '() => ({a:1,b:"x"})'],
    ['array', '() => [1,2,3]'],
    ['undefined', '() => undefined'],
    ['null', '() => null'],
    ['Error object', '() => new Error("x")'],
    ['Symbol', '() => Symbol("x")'],
    ['BigInt 10n', '() => 10n'],
    ['function', '() => function foo(){}'],
    ['DOM element', '() => document.body'],
    ['circular obj', '() => { const o={n:1}; o.self=o; return o; }'],
    ['window', '() => window'],
    ['Map', '() => new Map([["k",1]])'],
    ['Promise 500ms', '() => new Promise(r=>setTimeout(()=>r(42),500))'],
    ['Promise resolve now', '() => Promise.resolve(7)'],
    ['outerHTML (big str)', '() => document.documentElement.outerHTML'],
    ['outerHTML.length', '() => document.documentElement.outerHTML.length'],
  ];
  for (const [label, expr] of cases) {
    const r = await ev(pageId, expr, { ms: 25000 });
    ok(`${label} [${r.ms}ms] -> ${r.isErr ? 'ERR ' + tr(r.err, 120) : tr(r.result)}`);
  }
  // Promise that resolves at 10s — does the call block for it? (MAIN path does NOT await)
  const t0 = Date.now();
  const p10 = await ev(pageId, '() => new Promise(r=>setTimeout(()=>r("RESOLVED-10s"),10000))', { ms: 20000 });
  const el = Date.now() - t0;
  if (el < 9000) note('MED', 'evaluate_script does NOT await returned Promises', `returned in ${el}ms with ${tr(p10.result ?? p10.err)} — a resolved-later Promise serializes as empty; caller cannot get async results`);
  else ok(`10s promise awaited? elapsed=${el}ms result=${tr(p10.result)}`);
}

// =================================================================
console.log('\n== E. huge return value (resource / transport) ==');
{
  const t0 = Date.now();
  const r = await ev(pageId, '() => new Array(1e7).fill("x")', { ms: 90000 });
  const el = Date.now() - t0;
  if (r.isErr) note('LOW', `1e7 array -> error`, `${el}ms ${tr(r.err, 160)}`);
  else {
    const n = Array.isArray(r.result) ? r.result.length : 'n/a';
    note('LOW', `1e7 element array serialized+returned`, `${el}ms, len=${n}, ~${(r.rawText||'').length}b text — unbounded return value is a memory/DoS surface`);
  }
}

// =================================================================
console.log('\n== F. prototype pollution persistence + __mcp isolation ==');
{
  const set = await ev(pageId, `() => { Object.prototype.pwned = 'MAINPWN'; return 'set'; }`);
  ok(`pollute Object.prototype -> ${tr(set.result ?? set.err)}`);
  const chk = await ev(pageId, '() => ({}).pwned');
  if (S(chk.result) === '"MAINPWN"' || chk.result === 'MAINPWN') note('MED', 'main-world Object.prototype pollution PERSISTS across evaluate_script calls', `({}).pwned === ${tr(chk.result)} — evaluate_script shares one MAIN world`);
  else ok(`pollution did NOT persist: ${tr(chk.result)}`);
  // __mcp lib lives in ISOLATED world — is it visible / broken in main world?
  const mcpMain = await ev(pageId, '() => ({ ownPwn: ({}).pwned, mcp: typeof window.__mcp })');
  ok(`in MAIN world: __mcp=${mcpMain.result && mcpMain.result.mcp} (isolated-world lib not visible), pwned=${tr(mcpMain.result && mcpMain.result.ownPwn)}`);
  // Does pollution break the isolated-world lib? take_snapshot uses __mcp.
  const snap = unwrap(await call('take_snapshot', { pageId }));
  const lines = snap.result && (snap.result.lines || snap.result);
  if (snap.isErr) note('MED', 'take_snapshot broke after main-world pollution', snap.err);
  else ok(`take_snapshot still works after main-world pollution (lines=${Array.isArray(lines) ? lines.length : '?'}) — __mcp isolated world unaffected`);
  // cleanup
  await ev(pageId, '() => { delete Object.prototype.pwned; return "deleted"; }');
  const after = await ev(pageId, '() => ({}).pwned');
  ok(`after delete: ({}).pwned = ${tr(after.result)}`);
}

// =================================================================
console.log('\n== G. args plumbing / injection ==');
{
  const snap = unwrap(await call('take_snapshot', { pageId }));
  const uids = (snap.result && snap.result.uids) || [];
  const realUid = uids[0];
  ok(`snapshot uids: ${uids.length ? uids.slice(0, 4).join(',') : 'none'}`);
  if (realUid) {
    const r1 = await ev(pageId, '(el) => el ? el.tagName + "/" + (el.getAttribute("data-mcp-uid")||"") : "NULL"', { args: [realUid] });
    ok(`valid uid -> ${tr(r1.result ?? r1.err)}`);
    const r2 = await ev(pageId, '(el) => el ? "EL" : "NULL"', { args: ['e99999'] });
    ok(`fake uid e99999 -> ${r2.isErr ? 'ERR ' + tr(r2.err, 120) : tr(r2.result)}`);
    // injection-looking uid in MAIN path -> goes to querySelector, not eval
    const r3 = await ev(pageId, '(a,b) => "a=" + (a?1:0) + " b=" + (b?1:0)', { args: [realUid, 'e1";alert(1);//'] });
    ok(`inject-y 2nd uid (MAIN path) -> ${r3.isErr ? 'ERR ' + tr(r3.err, 140) : tr(r3.result)} (selector, not eval)`);
    const r4 = await ev(pageId, '(a) => "ok"', { args: ['plain-string-not-uid'] });
    ok(`non-uid string -> ${r4.isErr ? 'ERR ' + tr(r4.err, 120) : tr(r4.result)}`);
  }
}

// =================================================================
console.log('\n== H. dialogs ==');
{
  // dialogAction auto-accept: attaches debugger, auto-handles alert.
  const r1 = await ev(pageId, '() => { alert("auto"); return "after-alert"; }', { dialogAction: 'accept', ms: 20000 });
  ok(`alert() + dialogAction=accept -> ${r1.isErr ? 'ERR ' + tr(r1.err, 120) : tr(r1.result)} [${r1.ms}ms]`);

  // Unattended alert: debugger already attached, no pendingDialogAction.
  await call('list_console_messages', { pageId }); // ensures debugger attached
  const pend = call('evaluate_script', { pageId, function: '() => { alert("hang"); return "UNREACHABLE"; }' }, 25000);
  await sleep(1800); // alert is now open; eval blocked
  const hd = unwrap(await call('handle_dialog', { pageId, action: 'accept' }));
  ok(`handle_dialog accept while eval hung -> ${hd.isErr ? 'ERR ' + tr(hd.err, 120) : tr(hd.result)}`);
  const pr = await pend;
  const pru = unwrap(pr);
  ok(`eval after dialog accepted -> ${pru.isErr ? 'ERR ' + tr(pru.err, 120) : tr(pru.result)}`);
}

// =================================================================
console.log('\n== I. CSP fallback (meta CSP injected into example.com) ==');
{
  const csp = await ev(pageId, `() => { const m=document.createElement('meta'); m.httpEquiv='Content-Security-Policy'; m.content="script-src 'none'"; document.head.appendChild(m); return 'meta-added'; }`);
  ok(`inject meta CSP -> ${tr(csp.result ?? csp.err)}`);
  await sleep(300);
  // now eval should be CSP-blocked in MAIN world -> CDP Runtime.evaluate fallback
  const t0 = Date.now();
  const r1 = await ev(pageId, '() => document.title + " [csp-bypass]"', { ms: 25000 });
  ok(`eval under CSP [${r1.ms}ms] -> ${r1.isErr ? 'ERR ' + tr(r1.err, 160) : tr(r1.result)}`);
  if (!r1.isErr) note('INFO', 'CDP fallback bypassed page CSP', 'evaluate_script still executed on a script-src:none page via chrome.debugger Runtime.evaluate — CSP is no defense vs the extension (by design)');
  // Promise now AWAITED under CDP path (awaitPromise:true) — asymmetry check
  const pr = await ev(pageId, '() => new Promise(r=>setTimeout(()=>r("CDP-AWAITED"),600))', { ms: 15000 });
  ok(`promise under CDP path -> ${pr.isErr ? 'ERR ' + tr(pr.err, 120) : tr(pr.result)}`);
  // args injection under CDP path (args interpolated into evaluated expr)
  // uid crafted to break out of the single-quoted selector string in snapshot.js:152
  const inj = await ev(pageId, '() => "fnsrc-ran"', { args: ['x\'])||(window.__inj=\'CDP-INJECTED\')||(\''] , ms: 20000 });
  ok(`CDP-path arg injection -> ${inj.isErr ? 'ERR ' + tr(inj.err, 160) : tr(inj.result)}`);
  const injChk = await ev(pageId, '() => window.__inj', { ms: 20000 });
  if (S(injChk.result) === '"CDP-INJECTED"' || injChk.result === 'CDP-INJECTED')
    note('MED', 'args[] strings are interpolated into CDP Runtime.evaluate expression', 'a crafted uid broke out of the querySelector string and ran its own JS (same trust domain as fnSrc, but args are not validated/escaped — injection/DOS surface)');
  else ok(`CDP-path injection marker -> ${tr(injChk.result)}`);
  await call('detach_debugger', { pageId });
}

// =================================================================
console.log('\n== J. filePath output ==');
{
  const fp = OUT_DIR + '/out-eval.json';
  const r = await ev(pageId, '() => ({ok:1, msg:"written-by-evaluate_script"})', { filePath: fp });
  ok(`filePath write -> ${r.isErr ? 'ERR ' + tr(r.err, 120) : tr(r.rawText, 200)}`);
  note('HIGH', 'filePath = arbitrary local file write', `MCP client supplies filePath; bridge does fs.writeFileSync(path.resolve(p), content) with NO allowlist — can overwrite any file the bridge user can (startup items, configs). Design intent, but unscoped.`);
}

// =================================================================
console.log('\n== cleanup ==');
await call('detach_debugger', { pageId }).catch(() => {});
const cl = unwrap(await call('close_page', { pageId }));
ok(`close_page -> ${tr(cl.result ?? cl.err)}`);

// =================================================================
console.log('\n================ FINDINGS ================');
if (!findings.length) console.log('(none)');
for (const f of findings) console.log(`  [${f.sev}] ${f.title}`);
console.log(`\n${findings.filter(f => f.sev === 'CRITICAL' || f.sev === 'HIGH').length} high/critical, ${findings.length} total findings`);
process.exitCode = 0;
