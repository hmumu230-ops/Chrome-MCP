// adv-07d-eval.mjs — tester #07 rerun vs CURRENT code: evaluate_script async
// await regression, serialization edges, page-context escape surface, strict-CSP
// (github.com) CDP fallback, args/uid injection, exceptions, chrome://dead-tab/
// mid-navigation edges.
// Run: node adv-07d-eval.mjs
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
  const hasResKey = p && typeof p === 'object' && 'result' in p;
  return { isErr: false, result: hasResKey ? p.result : p, droppedKey: p && typeof p === 'object' && !hasResKey && JSON.stringify(p) === '{}' && txt.includes('"result"') === false, text: txt };
}
const ev = (pageId, fn, extra = {}) => call('evaluate_script', { pageId, function: fn, ...extra }, extra.ms || 30000).then(unwrap).then(u => ({ ...u }));
const S = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
const tr = (s, n = 160) => { s = S(s); return s && s.length > n ? s.slice(0, n) + `…(${s.length}b)` : s; };
const R = (r) => r.isErr ? 'ERR ' + tr(r.err, 200) : tr(r.result, 200);

async function newTab(url, background = false) {
  const r = unwrap(await call('new_page', { url, background }));
  const id = r.result && r.result.pageId;
  if (id) myTabs.add(id);
  return { id, r };
}
async function waitReady(pageId, tries = 30) {
  for (let k = 0; k < tries; k++) {
    const r = await ev(pageId, '() => document.readyState + "|" + location.href', { ms: 8000 });
    if (!r.isErr && /complete|interactive/.test(S(r.result))) return r;
    await sleep(700);
  }
  return await ev(pageId, '() => document.readyState + "|" + location.href', { ms: 8000 });
}

// ================= init =================
const init = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv07d', version: '0' } } });
console.log('init:', init.status, 'sid:', sid);
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const lp = unwrap(await call('list_pages', {}));
console.log('baseline tabs:', Array.isArray(lp.result) ? lp.result.length : '?');
console.log('ext id:', EXT_ID);

const A = (await newTab('https://example.com')).id;
console.log('tabA (example.com):', A);
await waitReady(A);
console.log('ready:', R(await ev(A, '() => document.title + " | " + location.origin')));

// ================= 1. ARGS & INJECTION (fresh tab — no snapshot yet => checkUid inert) =================
console.log('\n== 1. args plumbing + injection (no snapshot => staleness guard inert) ==');
{
  // The mission payload, MAIN path: uid goes into a CSS attribute selector, never executed.
  const injUid = 'x"});window.__INJM=1;//';
  const r1 = await ev(A, '(x) => x === null ? "GOT-NULL" : ("GOT:" + String(x).slice(0,60))', { args: [injUid] });
  ok(`malicious uid arg -> ${R(r1)}`);
  const r2 = await ev(A, '() => String(window.__INJM)');
  if (/^"1"|^1$/.test(S(r2.result))) note('CRITICAL', 'uid arg executed JS in MAIN world', r2.result);
  else ok(`__INJM after injection attempt -> ${tr(r2.result)} (no code exec)`);

  // Mission check verbatim: ({uid}) => uid with malicious uid — args are ELEMENT
  // handles, not raw strings; null destructure throws instead of returning literal.
  const r3 = await ev(A, '({uid}) => uid', { args: [injUid] });
  ok(`({uid})=>uid with crafted uid -> ${R(r3)}  [arg is element handle or null — uid string is never passed as a value]`);

  // quote/backslash-only selector break attempts
  for (const u of ['"', '\\\\', '"]', 'x\\"]', 'a"b"c', '"] [data-mcp-uid="', '*', '']) {
    const r = await ev(A, '(x) => x === null ? "null" : "MATCHED:" + x.tagName', { args: [u] });
    ok(`uid ${JSON.stringify(u).slice(0, 40)} -> ${R(r)}`);
  }
  const r4 = await ev(A, '() => String(window.__INJM)');
  ok(`__INJM re-check -> ${tr(r4.result)}`);

  // non-string / non-array args shapes
  const shapes = await ev(A, '(a) => a === null ? "null" : typeof a', { args: [{ a: 1 }] });
  ok(`args:[{a:1}] -> ${R(shapes)}`);
  const strArg = await ev(A, '(a) => 1', { args: 'xy' });
  ok(`args:"xy" (non-array) -> ${R(strArg)}`);
  const numArg = await ev(A, '(a) => 1', { args: 5 });
  ok(`args:5 -> ${R(numArg)}`);

  // Now take a snapshot -> staleness guard activates; then real-uid test.
  const snap = unwrap(await call('take_snapshot', { pageId: A }));
  const uids = snap.result && snap.result.uids || (snap.result && snap.result.lines ? [] : []);
  // uids not returned by take_snapshot (returns lines); grab one via evaluate instead:
  const uidq = await ev(A, '() => { const e = document.querySelector("[data-mcp-uid]"); return e ? e.getAttribute("data-mcp-uid") : null; }');
  const realUid = uidq.result;
  ok(`real uid in DOM -> ${tr(realUid)}`);
  if (realUid) {
    const rv = await ev(A, '(el) => el ? el.tagName + "/" + el.getAttribute("data-mcp-uid") : "NULL"', { args: [realUid] });
    ok(`valid uid -> ${R(rv)}`);
    const stale = await ev(A, '(el) => "x"', { args: ['definitely-not-a-uid"] ) ; window.__INJM=3;//'] });
    ok(`fake uid after snapshot -> ${R(stale)}  [staleness guard]`); 
    const inj2 = await ev(A, '() => String(window.__INJM)');
    ok(`__INJM final -> ${tr(inj2.result)}`);
  }
}

// ================= 2. REGRESSION: async / promise awaiting =================
console.log('\n== 2. REGRESSION: async scripts must await ==');
{
  const t0 = Date.now();
  const r1 = await ev(A, 'async () => { await new Promise(r=>setTimeout(r,100)); return 42 }');
  const dt = Date.now() - t0;
  if (r1.result === 42 && dt >= 100) ok(`async 42 after ${dt}ms — awaited correctly`);
  else note('HIGH', 'async result wrong', `got ${tr(r1.result ?? r1.err)} in ${dt}ms`);

  for (const [label, fn] of [
    ['async->object', 'async () => ({a:1,b:[2,3]})'],
    ['async->array', 'async () => [1,2,3]'],
    ['async->undefined', 'async () => undefined'],
    ['async->throw Error', 'async () => { throw new Error("async-boom") }'],
    ['async->reject string', 'async () => Promise.reject("rej-str")'],
    ['async->reject object', 'async () => Promise.reject({code:7})'],
    ['sync fn -> promise(7)', '() => new Promise(r=>setTimeout(()=>r(7),60))'],
    ['sync 42', '() => 42'],
    ['await fetch own origin', 'async () => (await fetch("/")).status'],
  ]) {
    const r = await ev(A, fn);
    ok(`${label} -> ${R(r)}`);
  }
}

// ================= 3. serialization edge cases (MAIN path) =================
console.log('\n== 3. serialization edge cases (MAIN world, norm()) ==');
{
  const cases = [
    ['BigInt', '() => 9007199254740993n'],
    ['Symbol', '() => Symbol("desc")'],
    ['function', '() => function namedFn(a,b){}'],
    ['anon arrow', '() => (()=>1)'],
    ['DOM element', '() => document.body'],
    ['document', '() => document'],
    ['cyclic', '() => { const o={a:1}; o.me=o; return o }'],
    ['shared-ref (not cyclic)', '() => { const s={x:1}; return [s,s] }'],
    ['Map', '() => new Map([["k",1]])'],
    ['Set', '() => new Set([1,2])'],
    ['Date', '() => new Date(0)'],
    ['RegExp', '() => /ab+c/gi'],
    ['Uint8Array', '() => new Uint8Array([1,2,255])'],
    ['ArrayBuffer', '() => new ArrayBuffer(4)'],
    ['[Inf,-Inf,NaN,-0]', '() => [Infinity,-Infinity,NaN,-0]'],
    ['Error obj', '() => new Error("errval")'],
    ['NodeList', '() => document.querySelectorAll("div")'],
    ['throwing getter', '() => { const o={a:1}; Object.defineProperty(o,"boom",{enumerable:true,get(){throw new Error("GETTER")}}); return o }'],
    ['throwing toJSON', '() => ({toJSON(){throw new Error("TJ")}})'],
    ['Proxy get-trap', '() => new Proxy({}, {get(t,p){throw new Error("GET-TRAP:"+String(p))}})'],
    ['Proxy ownKeys-trap', '() => new Proxy({a:1}, {ownKeys(){throw new Error("OWK")}, getOwnPropertyDescriptor(){throw new Error("GOPD")}})'],
    ['window', '() => window'],
    ['envelope-lookalike', '() => ({__ok:false, err:"fake-page-error"})'],
    ['null', '() => null'],
    ['nested x500', '() => { let o={leaf:1}; for(let i=0;i<500;i++) o={next:o,d:i}; return o }'],
  ];
  for (const [label, fn] of cases) {
    const r = await ev(A, fn);
    const resStr = tr(r.result, 140);
    console.log(`  ${r.isErr ? 'ERR ' : '    '} ${label} -> ${r.isErr ? tr(r.err, 140) : resStr}`);
    if (label === 'envelope-lookalike' && r.isErr) note('MED', 'return value matching {__ok:false} envelope is reported as a page error', `returned {__ok:false,err:"fake-page-error"} -> tool error "${r.err}" (envelope confusion)`);
    if (label === 'shared-ref (not cyclic)' && /Circular/.test(S(r.result))) note('LOW', 'shared (non-cyclic) refs mislabeled [Circular]', tr(r.result, 120));
  }
  // depth check: count depth of nested result
  const dn = await ev(A, '() => { let o={leaf:1}; for(let i=0;i<500;i++) o={next:o,d:i}; return o }');
  let depth = 0, cur = dn.result; while (cur && cur.next) { depth++; cur = cur.next; }
  ok(`nested depth measured -> ${depth} (sent 500)`);

  // 5MB string — report size only
  {
    const t0 = Date.now();
    const r = await ev(A, '() => "x".repeat(5*1024*1024)', { ms: 60000 });
    const len = typeof r.result === 'string' ? r.result.length : -1;
    const bytes = (r.text || '').length;
    if (len === 5 * 1024 * 1024) ok(`5MB string returned intact (len=${len}, respText=${bytes}b, ${Date.now() - t0}ms)`);
    else note('MED', '5MB string result abnormal', `len=${len} err=${tr(r.err)} respText=${bytes}`);
  }
}

// ================= 4. exceptions (MAIN path) =================
console.log('\n== 4. exceptions propagate truthfully (MAIN) ==');
{
  for (const [label, fn] of [
    ['throw string', '() => { throw "str-err" }'],
    ['throw object', '() => { throw {code:42,msg:"obj"} }'],
    ['throw TypeError', '() => { throw new TypeError("te-detail") }'],
    ['throw null', '() => { throw null }'],
    ['syntax error unclosed', '() => {'],
    ['not a function: 42', '42'],
    ['garbage src', 'this is not js {{{'],
    ['throw Error with newline', '() => { throw new Error("line1\\nline2") }'],
  ]) {
    const r = await ev(A, fn);
    console.log(`  ${r.isErr ? 'ERR ' : 'VAL '} ${label} -> ${r.isErr ? tr(r.err, 160) : tr(r.result, 160)}`);
    if (label === 'throw object' && /object Object/.test(S(r.err))) note('LOW', 'thrown objects serialize as [object Object] — detail lost (MAIN path)', r.err);
    if (label === 'throw TypeError' && !/TypeError/.test(S(r.err))) note('LOW', 'error NAME dropped — only e.message survives (MAIN path)', `threw TypeError("te-detail") -> "${r.err}"`);
  }
}

// ================= 5. escape surface from page context =================
console.log('\n== 5. escape attempts / reachable surface (page context) ==');
{
  const surf = await ev(A, `() => ({ hasChrome: typeof chrome, keys: (window.chrome ? Object.keys(chrome) : []), rt: typeof (chrome && chrome.runtime), rtId: (chrome && chrome.runtime && chrome.runtime.id) || null, dbg: typeof (chrome && chrome.debugger), tabs: typeof (chrome && chrome.tabs), mcp: typeof window.__mcp })`);
  console.log('  surface:', tr(surf.result, 300));
  if (surf.result && surf.result.rtId === EXT_ID) note('CRITICAL', 'page sees extension runtime.id', EXT_ID);
  if (surf.result && surf.result.mcp !== 'undefined') note('MED', 'isolated-world __mcp visible from MAIN world', surf.result.mcp);
  else ok('window.__mcp not visible from MAIN world (isolation holds)');

  // sendMessage to our own extension (no externally_connectable -> must fail)
  await ev(A, `() => { window.__sm='pending'; try { chrome.runtime.sendMessage('${EXT_ID}', {x:1}, (r) => { window.__sm = chrome.runtime.lastError ? 'lastError:' + chrome.runtime.lastError.message : 'RESP:' + JSON.stringify(r); }); } catch(e) { window.__sm = 'threw:' + e.message; } return 'armed'; }`);
  await sleep(700);
  const sm = await ev(A, '() => window.__sm');
  if (/RESP:/.test(S(sm.result))) note('CRITICAL', 'page reached extension via chrome.runtime.sendMessage', sm.result);
  else ok(`sendMessage(extId) -> ${tr(sm.result)}`);

  // scheme reaches
  await ev(A, `() => { window.__fx='p'; fetch('chrome-extension://${EXT_ID}/manifest.json').then(r=>r.text()).then(t=>window.__fx='OK len='+t.length).catch(e=>window.__fx='ERR '+e.message); return 'a'; }`);
  await ev(A, `() => { window.__fc='p'; fetch('chrome://version/').then(r=>window.__fc='OK '+r.status).catch(e=>window.__fc='ERR '+e.message); return 'a'; }`);
  await ev(A, `() => { window.__ff='p'; fetch('file:///C:/Windows/win.ini').then(r=>window.__ff='OK '+r.status).catch(e=>window.__ff='ERR '+e.message); return 'a'; }`);
  await ev(A, `() => { window.__fb='p'; fetch('http://127.0.0.1:7890/mcp',{method:'POST',headers:{'content-type':'text/plain'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}'}).then(r=>r.text()).then(t=>window.__fb='OK '+t.slice(0,120)).catch(e=>window.__fb='ERR '+e.message); return 'a'; }`);
  // credentialed cross-origin fetch (CSRF surface — sends cookies, cannot read)
  await ev(A, `() => { window.__gh='p'; fetch('https://github.com/',{credentials:'include'}).then(r=>window.__gh='READ-OK '+r.status).catch(e=>window.__gh='ERR '+e.message); return 'a'; }`);
  await sleep(2000);
  for (const [label, g] of [['fetch chrome-extension://self manifest', '__fx'], ['fetch chrome://version', '__fc'], ['fetch file://win.ini', '__ff'], ['POST bridge /mcp text/plain (no-preflight simple req)', '__fb'], ['fetch github credentialed', '__gh']]) {
    const r = await ev(A, `() => window.${g}`);
    const v = S(r.result);
    if (/^"?OK|^"?READ-OK/.test(v)) note('MED', `${label} succeeded from page`, tr(r.result, 160));
    else ok(`${label} -> ${tr(r.result, 120)}`);
  }

  // cross-origin iframe DOM + storage
  await ev(A, `() => { window.__xo='pending'; const f=document.createElement('iframe'); f.src='https://github.com/'; f.onload=()=>{ try { window.__xo='doc:' + (f.contentDocument ? f.contentDocument.title : 'null-doc'); } catch(e){ window.__xo='SOP:'+e.name; } try { f.contentWindow.localStorage.getItem('x'); window.__xo+=' ls:OK'; } catch(e){ window.__xo+=' ls:'+e.name; } try { window.__xo+=' cookie:'+f.contentWindow.document.cookie; } catch(e){ window.__xo+=' cookie:'+e.name; } }; document.body.appendChild(f); return 'armed'; }`);
  await sleep(2500);
  const xo = await ev(A, '() => window.__xo');
  ok(`cross-origin iframe -> ${tr(xo.result, 200)}`);

  // window.open to another origin — what does the returned proxy expose?
  const wo = await ev(A, `() => { const w = window.open('https://example.org','_blank'); if (!w) return 'popup-blocked'; window.__w = w; try { return 'opened doc:' + (w.document ? 'accessible' : 'null'); } catch(e) { return 'opened but document -> ' + e.name; } }`);
  ok(`window.open -> ${tr(wo.result)}`);
  const wo2 = await ev(A, `() => { const w = window.__w; if (!w) return 'no-w'; const out = { closed: w.closed }; try { out.href = w.location.href; } catch(e) { out.href = e.name; } try { out.doc = String(w.document && w.document.title); } catch(e) { out.doc = e.name; } try { out.ls = typeof w.localStorage; } catch(e) { out.ls = e.name; } try { w.postMessage('hi','*'); out.pm='sent'; } catch(e) { out.pm = e.name; } return out; }`);
  ok(`cross-origin window proxy -> ${tr(wo2.result, 200)}`);
  // close whatever we opened
  await ev(A, '() => { try { window.__w && window.__w.close(); } catch(e){} return "closed"; }');
  await sleep(500);
  const lp2 = unwrap(await call('list_pages', {}));
  const stray = (lp2.result || []).filter(t => /example\.org/.test(t.url) && !myTabs.has(t.pageId));
  for (const t of stray) { await call('close_page', { pageId: t.pageId }); console.log('  closed stray window.open tab', t.pageId); }

  // own-origin storage/cookie baseline + monkey-patch capability
  const ls = await ev(A, `() => { localStorage.setItem('__adv07','1'); return localStorage.getItem('__adv07') + '/' + localStorage.length; }`);
  ok(`localStorage own-origin -> ${tr(ls.result)}`);
  const hk = await ev(A, '() => { const of = window.fetch; window.fetch = (...a) => Promise.resolve(new Response("HIJACKED")); return "patched:" + (window.fetch !== of); }');
  ok(`can monkey-patch window.fetch (page tamper capability) -> ${tr(hk.result)}`);
  await ev(A, '() => location.reload() && 0').catch(() => {});
  await sleep(1200);
  const hk2 = await ev(A, '() => window.fetch.toString().slice(0,60)');
  ok(`after reload fetch -> ${tr(hk2.result)}`);
}

// ================= 6. strict CSP page: github.com -> CDP fallback =================
console.log('\n== 6. CSP-strict page (github.com) — CDP fallback path ==');
{
  const B = (await newTab('https://github.com')).id;
  console.log('  tabB (github.com):', B);
  const rd = await waitReady(B, 40);
  ok(`github ready -> ${tr(rd.result ?? rd.err, 120)}`);

  // First eval: does MAIN-path indirect eval get CSP-blocked and fall back to CDP?
  const t0 = Date.now();
  const g1 = await ev(B, '() => document.title.slice(0,40) + "|" + location.host', { ms: 30000 });
  ok(`github eval [${Date.now() - t0}ms] -> ${R(g1)}`);

  // Which path ran? BigInt differs: norm() gives "10n", CDP returnByValue drops .value.
  const gb = await ev(B, '() => 10n');
  ok(`github BigInt -> ${R(gb)}  [MAIN="10n" string; CDP=undefined/unserializable]`);
  if (!gb.isErr && gb.result === undefined) note('LOW', 'CDP fallback serialization diverges: BigInt returns undefined (no norm())', 'MAIN path would return "10n"');
  const gc = await ev(B, '() => { const o={a:1}; o.me=o; return o }');
  ok(`github cyclic -> ${R(gc)}`);
  const ge = await ev(B, '() => document.body');
  ok(`github element -> ${R(ge)}`);
  const gu = await ev(B, '() => undefined');
  ok(`github undefined -> ${tr(gu.result) === undefined || gu.result === undefined ? String(gu.result) : tr(gu.result)} | raw=${tr(gu.text, 120)}`);
  const gx = await ev(B, '() => { throw new Error("cdp-path-err") }');
  ok(`github throw Error -> ${gx.isErr ? tr(gx.err, 200) : 'NO-ERR ' + tr(gx.result)}`);
  const gs = await ev(B, '() => { throw {code:9} }');
  ok(`github throw object -> ${gs.isErr ? tr(gs.err, 200) : 'NO-ERR ' + tr(gs.result)}`);
  const tA = Date.now();
  const ga = await ev(B, 'async () => { await new Promise(r=>setTimeout(r,150)); return 43 }');
  ok(`github async->43 [${Date.now() - tA}ms] -> ${R(ga)}  [CDP awaitPromise]`);

  // CDP-path args injection: uids go through JSON.stringify literal — verify no exec.
  const inj = await ev(B, '(x) => x === null ? "null-arg" : "EL"', { args: ['x"});window.__INJG=1;//'] });
  ok(`github malicious uid -> ${R(inj)}`);
  const injChk = await ev(B, '() => String(window.__INJG)');
  if (/^"?1/.test(S(injChk.result))) note('CRITICAL', 'CDP-path args injection executed', injChk.result);
  else ok(`github __INJG -> ${tr(injChk.result)} (JSON-literal interpolation is safe)`);

  // uid element resolution on CDP path (needs snapshot -> data-mcp-uid attrs exist)
  const snapB = unwrap(await call('take_snapshot', { pageId: B }));
  const uidB = await ev(B, '() => { const e=document.querySelector("[data-mcp-uid]"); return e && e.getAttribute("data-mcp-uid"); }');
  if (uidB.result) {
    const ru = await ev(B, '(el) => el ? el.tagName : "NULL"', { args: [uidB.result] });
    ok(`github uid via CDP path -> ${R(ru)}`);
  } else ok('github: no data-mcp-uid in DOM after snapshot (?)');

  const det = unwrap(await call('detach_debugger', { pageId: B }));
  ok(`detach_debugger github -> ${tr(det.result ?? det.err)}`);
}

// ================= 7. edge targets =================
console.log('\n== 7. edge targets: chrome://, dead tab, about:blank, extension page, data:, mid-navigation ==');
{
  const C = (await newTab('chrome://version/')).id;
  await sleep(1500);
  const ce = await ev(C, '() => 1+1', { ms: 15000 });
  ok(`evaluate on chrome://version -> ${R(ce)}`);
  if (!ce.isErr) note('HIGH', 'script executed on chrome:// page', tr(ce.result));
  const ceDbg = await ev(C, '() => 2', { dialogAction: 'accept', ms: 15000 });
  ok(`evaluate chrome:// + dialogAction (debugger path) -> ${R(ceDbg)}`);

  const dead = await ev(999999999, '() => 1');
  ok(`dead tab 999999999 -> ${R(dead)}`);
  const dead2 = await ev(-5, '() => 1');
  ok(`dead tab -5 -> ${R(dead2)}`);
  const deadStr = await ev('abc', '() => 1');
  ok(`non-integer pageId "abc" -> ${R(deadStr)}`);

  const D = (await newTab('about:blank')).id;
  await sleep(800);
  const ab = await ev(D, '() => 2+2 + "|" + location.href');
  ok(`about:blank -> ${R(ab)}`);

  const E = (await newTab(`chrome-extension://${EXT_ID}/popup.html`)).id;
  await sleep(1200);
  const ep = await ev(E, '() => typeof chrome + "/" + typeof (chrome && chrome.runtime) + "/" + document.title');
  ok(`own extension page popup.html -> ${R(ep)}`);
  if (!ep.isErr && /object/.test(S(ep.result))) note('MED', 'evaluate_script runs inside own extension page — chrome.runtime reachable there', tr(ep.result, 160));

  const F = (await newTab('data:text/html,<h1>datapage</h1>')).id;
  await sleep(1200);
  const dp = await ev(F, '() => document.body ? document.body.innerText : "nobody"');
  ok(`data: URL page -> ${R(dp)}`);

  // error page (dns failure) — chrome-error://
  const nav = unwrap(await call('navigate_page', { pageId: D, type: 'url', url: 'https://definitely-not-a-real-domain-xyz123.invalid/' }));
  await sleep(1000);
  const errp = await ev(D, '() => 1+1', { ms: 15000 });
  ok(`evaluate on chrome-error page -> ${R(errp)}`);

  // mid-navigation: fire evaluate while navigate is in flight (3 rounds)
  for (let k = 0; k < 3; k++) {
    const np = call('navigate_page', { pageId: A, type: 'url', url: k % 2 ? 'https://example.com/' : 'https://example.org/' }, 20000);
    await sleep(30);
    const mid = await ev(A, '() => location.href + "|rs:" + document.readyState', { ms: 15000 });
    console.log(`  mid-nav eval#${k} -> ${R(mid)}`);
    await np;
    await sleep(400);
  }

  // evaluate on tab being closed: start eval on a fresh tab then close it mid-flight
  const G = (await newTab('https://example.com')).id;
  await waitReady(G);
  const slow = ev(G, 'async () => { await new Promise(r=>setTimeout(r,8000)); return "LATE" }', { ms: 25000 });
  await sleep(800);
  const cl = unwrap(await call('close_page', { pageId: G }));
  myTabs.delete(G);
  ok(`close_page during pending eval -> ${tr(cl.result ?? cl.err)}`);
  const sr = await slow;
  ok(`eval result after its tab closed -> ${sr.isErr ? 'ERR ' + tr(sr.err, 160) : tr(sr.result)}`);
}

// ================= 8. resource: never-resolving promise + infinite loop =================
console.log('\n== 8. hang surface (own throwaway tab) ==');
{
  const H = (await newTab('https://example.com')).id;
  await waitReady(H);
  const t0 = Date.now();
  const pend = await ev(H, '() => new Promise(()=>{})', { ms: 15000 });
  const dt = Date.now() - t0;
  if (dt >= 14000) note('MED', 'evaluate_script has no per-script timeout — never-resolving promise wedges the call', `still no result after ${dt}ms (bridge CALL_TIMEOUT_MS=120s); a bad script = 2min hang`);
  else ok(`never-promise returned in ${dt}ms -> ${R(pend)}`);

  // infinite loop: wedges the renderer; call hangs; closing the tab frees it.
  const t1 = Date.now();
  const loop = ev(H, '() => { while(1){} }', { ms: 12000 });
  const lr = await loop;
  const dt2 = Date.now() - t1;
  if (dt2 >= 11000) note('MED', 'infinite-loop script wedges page renderer; call hangs until timeout', `${dt2}ms no response — page main thread dead until tab closed`);
  else ok(`infinite loop -> ${R(lr)} in ${dt2}ms`);
  const clH = unwrap(await call('close_page', { pageId: H }));
  myTabs.delete(H);
  ok(`close wedged tab -> ${tr(clH.result ?? clH.err)}`);
}

// ================= cleanup =================
console.log('\n== cleanup: close only my tabs ==');
const lpEnd = unwrap(await call('list_pages', {}));
const stillMine = (lpEnd.result || []).filter(t => myTabs.has(t.pageId));
for (const t of stillMine) {
  const c = unwrap(await call('close_page', { pageId: t.pageId }));
  console.log(`  closed ${t.pageId} ${tr(t.url, 60)} -> ${tr(c.result ?? c.err, 80)}`);
}
const lpFin = unwrap(await call('list_pages', {}));
console.log(`  tabs before=${Array.isArray(lp.result) ? lp.result.length : '?'} after=${Array.isArray(lpFin.result) ? lpFin.result.length : '?'}`);

console.log('\n================ FINDINGS ================');
if (!findings.length) console.log('(none)');
for (const f of findings) console.log(`  [${f.sev}] ${f.t}`);
console.log(`\ntotal ${findings.length} findings`);
process.exitCode = 0;
