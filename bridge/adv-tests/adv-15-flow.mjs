// adv-15-flow.mjs — realistic composite agent workflows + failure recovery.
//  P1  Full agent loop: new_page(example.com) -> snapshot -> click link -> wait_for
//      -> extract_text -> screenshot -> back -> forward. Whole-chain timing.
//  P2  Multi-page: fill form on tab B while tab C navigates; uid cross-tab checks
//      (same uid string on two tabs = silent wrong-element hit, stale uid,
//      never-snapshotted tab).
//  P3  Recovery: page-side error, 8s-promise eval, wait_for timeout, dead pageId
//      -> is the session still valid after each?
//  P4  Debugger zombie: attach via list_network_requests -> close_page(tab dies
//      attached) -> new tab -> capture again (no leaked session).
//  P5  modalDialogs: alert via evaluate_script -> next result carries the hint ->
//      handle_dialog(accept) clears -> blocking alert() unblocked by a concurrent
//      handle_dialog on the SAME session.
//  P6  Session churn: 10 rapid create/abandon + all call tools -> DELETE all ->
//      GET / sessions returns toward baseline (other agents share this bridge —
//      counts are tolerant).
//  P7  Stress-lite: 3 sessions x {snapshot -> click -> screenshot} on own tabs.
//  P8  Cleanup: detach debuggers, close ONLY our tabs, DELETE our sessions, GET /.
//
// about:blank is NOT injectable (no matchAboutBlank in manifest), so all
// content pages come from a tiny local HTTP server on :17895.

import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const BASE = 'http://127.0.0.1:7890/mcp';
const ROOT = 'http://127.0.0.1:7890/';
const OUT = 'D:/Tool/chrome-mcp/bridge/test-out';
const LPORT = 17895;
const L = `http://127.0.0.1:${LPORT}`;

const mySessions = new Set();
const myTabs = new Set();
const checks = [];
const findings = [];
const ok = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const note = (severity, finding, evidence) => findings.push({ severity, finding, evidence });
const ms = (t) => Math.round(performance.now() - t);
const t0all = performance.now();

setTimeout(() => { console.log('\nWATCHDOG 230s — forcing exit'); process.exit(2); }, 230000).unref();

// ---------- tiny local page server ----------
const PAGES = {
  '/form': '<h1>FormPage</h1><input id="a1"><input id="a2"><button>Go</button><a id="tg" href="#x">tog</a>',
  '/links': '<h1>LinkPage</h1><a href="/page2">goto2</a>',
  '/page2': '<h1>Page2</h1><p>landed-here</p><a href="/a">toa</a>',
  '/a': '<h1>PageA</h1><p>aaa</p><a href="/b">tob</a>',
  '/b': '<h1>PageB</h1><p>bbb</p>',
};
const lserver = http.createServer((req, res) => {
  const path = new URL(req.url, L).pathname;
  const body = PAGES[path];
  if (!body) { res.writeHead(404).end('nope'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body>' + body + '</body></html>');
});
await new Promise(r => lserver.listen(LPORT, '127.0.0.1', r));

const status = async () => {
  try { const r = await fetch(ROOT); return await r.json(); }
  catch (e) { return { error: String(e && e.message || e) }; }
};

async function rawPost(body, sid, timeoutMs = 60000) {
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const t0 = performance.now();
  try {
    const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    const msgs = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {} }
    }
    if (!msgs.length && text.trim().startsWith('{')) { try { msgs.push(JSON.parse(text)); } catch {} }
    return { status: r.status, sid: r.headers.get('mcp-session-id'), msg: msgs[msgs.length - 1], ms: performance.now() - t0, bytes: text.length };
  } catch (e) {
    return { status: 0, error: String(e && e.name === 'TimeoutError' ? `client timeout >${timeoutMs}ms` : (e && e.message || e)), ms: performance.now() - t0, bytes: 0 };
  }
}

async function mk(name) {
  const init = await rawPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '0' } } });
  if (init.status !== 200 || !init.sid) return { ok: false, status: init.status, error: init.error || 'no sid', call: async () => ({ isError: true, err: 'no session' }) };
  const sid = init.sid;
  mySessions.add(sid);
  await rawPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  let i = 1;
  const call = async (n, a, timeoutMs) => {
    const id = ++i;
    const r = await rawPost({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: n, arguments: a || {} } }, sid, timeoutMs);
    const res = r.msg && r.msg.result;
    const text = res && res.content && res.content[0] && res.content[0].type === 'text' ? res.content[0].text : '';
    return {
      ms: r.ms, status: r.status,
      isError: !!(res && res.isError),
      err: res && res.isError ? String(res.content?.[0]?.text || '').slice(0, 220)
           : (r.error || r.rpcErr || (r.status && r.status >= 400 ? 'HTTP ' + r.status : null)),
      sc: res && res.structuredContent, text,
    };
  };
  return { ok: true, sid, call, initMs: init.ms };
}

async function closeSession(sid) {
  try { await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': sid } }); } catch {}
  mySessions.delete(sid);
}

const uidFromLine = (line) => (line.match(/\[([^\]]+)\]/) || [])[1];
const findUid = (lines, re) => { const l = (lines || []).find(x => re.test(x)); return l ? uidFromLine(l) : null; };

const T = {}; // named tab ids shared across phases
const health0 = await status();
console.log('== adv-15-flow == baseline:', JSON.stringify(health0));

// Pre-clean: tabs orphaned by previous crashed runs (my local-server pages,
// my P1 iana destination). Only close pages matching MY distinctive URLs.
{
  const probe = await mk('adv-15-preclean');
  if (probe.ok) {
    const lp = await probe.call('list_pages', {});
    const mine = (lp.sc?.items || []).filter(t => /127\.0\.0\.1:17895|iana\.org\/help\/example-domains/.test(t.url || ''));
    for (const t of mine) { await probe.call('close_page', { pageId: t.pageId }); }
    if (mine.length) console.log(`  pre-clean: closed ${mine.length} leftover tab(s)`);
    await closeSession(probe.sid);
  }
}

const bridgeAlive = async () => (await status()).extensionConnected === true;
const needBridge = async (phase) => {
  const up = await bridgeAlive();
  if (!up) { ok(phase + ' skipped — bridge DOWN', false, 'GET / unreachable or extension disconnected'); note('critical', 'bridge process unreachable mid-run (phase ' + phase + ')', 'GET / failed'); }
  return up;
};

// ============================== P1 — full agent loop ======================
console.log('\n-- P1 full agent loop (example.com -> iana.org -> back/forward) --');
const s1 = await mk('adv-15-p1');
const p1 = {};
const T1 = performance.now();
try {
  let t = performance.now();
  const np = await s1.call('new_page', { url: 'https://example.com' });
  const pageA = np.sc && np.sc.pageId; if (pageA) myTabs.add(pageA); T.A = pageA;
  p1.new_page = ms(t); ok('P1 new_page', !np.isError && !!pageA, `${p1.new_page}ms pageId=${pageA} ${np.err || ''}`);

  t = performance.now();
  const snap = await s1.call('take_snapshot', { pageId: pageA });
  p1.snapshot = ms(t);
  const linkUid = findUid(snap.sc && snap.sc.lines, /information|iana|learn more/i);
  ok('P1 take_snapshot', !snap.isError && (snap.sc?.lines || []).length > 0, `${p1.snapshot}ms lines=${(snap.sc?.lines || []).length}`);
  ok('P1 link uid found', !!linkUid, `uid=${linkUid}`);

  t = performance.now();
  const clk = await s1.call('click', { pageId: pageA, uid: linkUid });
  p1.click = ms(t); ok('P1 click', !clk.isError, `${p1.click}ms via=${clk.sc?.via} ${clk.err || ''}`);

  t = performance.now();
  const wf = await s1.call('wait_for', { pageId: pageA, text: ['IANA', 'Example Domains'], timeout: 15000 });
  p1.wait_for = ms(t); ok('P1 wait_for', !wf.isError && wf.sc?.found, `${p1.wait_for}ms ${wf.err || ''}`);

  t = performance.now();
  const ex = await s1.call('extract_text', { pageId: pageA });
  p1.extract = ms(t);
  ok('P1 extract_text on iana', !ex.isError && /iana\.org/.test(ex.sc?.url || ''), `${p1.extract}ms url=${ex.sc?.url} len=${(ex.sc?.text || '').length}`);

  t = performance.now();
  const shot = await s1.call('take_screenshot', { pageId: pageA, format: 'jpeg', quality: 50, filePath: `${OUT}/adv15-p1.jpg` });
  p1.screenshot = ms(t); ok('P1 take_screenshot', !shot.isError && /adv15-p1/.test(shot.text || ''), `${p1.screenshot}ms ${shot.err || ''}`);

  t = performance.now();
  const back = await s1.call('navigate_page', { pageId: pageA, type: 'back' });
  p1.back = ms(t); ok('P1 back -> example.com', !back.isError && /example\.com/.test(back.sc?.url || ''), `${p1.back}ms url=${back.sc?.url} ${back.err || ''}`);

  t = performance.now();
  const fwd = await s1.call('navigate_page', { pageId: pageA, type: 'forward' });
  p1.forward = ms(t); ok('P1 forward -> iana', !fwd.isError && /iana\.org/.test(fwd.sc?.url || ''), `${p1.forward}ms url=${fwd.sc?.url} ${fwd.err || ''}`);
} catch (e) { ok('P1 chain threw', false, String(e && e.message || e)); }
p1.total = ms(T1);
console.log('  P1 step timings:', JSON.stringify(p1));

// ============================== P2 — multi-page uid isolation =============
console.log('\n-- P2 multi-page uid isolation / cross-talk --');
try {
  const t = performance.now();
  const nb = await s1.call('new_page', { url: `${L}/form`, background: true });
  const B = nb.sc && nb.sc.pageId; myTabs.add(B); T.B = B;
  const nc = await s1.call('new_page', { url: `${L}/links`, background: true });
  const C = nc.sc && nc.sc.pageId; myTabs.add(C); T.C = C;
  ok('P2 tabs B,C created', !!B && !!C, `B=${B} C=${C}`);

  const snapB = await s1.call('take_snapshot', { pageId: B });
  const inputUid = findUid(snapB.sc?.lines, /textbox/);
  ok('P2 B snapshot has input uid', !!inputUid, `uid=${inputUid} lines=${(snapB.sc?.lines || []).length}`);

  // Concurrent: fill on B while C navigates — routed by pageId, should not interfere.
  const [fillR, navR] = await Promise.all([
    s1.call('fill', { pageId: B, uid: inputUid, value: 'agentA-typed' }),
    s1.call('navigate_page', { pageId: C, type: 'url', url: `${L}/page2` }),
  ]);
  const vB = await s1.call('evaluate_script', { pageId: B, function: '()=>document.querySelector("#a1").value' });
  const vC = await s1.call('evaluate_script', { pageId: C, function: '()=>location.href' });
  ok('P2 fill(B) || navigate(C) no cross-talk',
    !fillR.isError && !navR.isError && vB.sc?.result === 'agentA-typed' && /\/page2/.test(vC.sc?.result || ''),
    `fill=${Math.round(fillR.ms)}ms nav=${Math.round(navR.ms)}ms B.value=${vB.sc?.result} C.href=${vC.sc?.result} ${fillR.err || ''} ${navR.err || ''}`);

  // C's own fresh snapshot (navigation cleared its frameMap).
  const snapC = await s1.call('take_snapshot', { pageId: C });
  const cUids = (snapC.sc?.lines || []).map(uidFromLine).filter(Boolean);
  ok('P2 C snapshot', cUids.length > 0, `C uids=${cUids.join(',')}`);

  // Stale uid FIRST (the collision click below navigates C -> clears frameMap):
  // 'e999' absent from C's map -> loud "stale uid" error expected.
  const stale = await s1.call('click', { pageId: C, uid: 'e999' });
  ok('P2 stale uid on C errors loudly', stale.isError && /stale uid/.test(stale.err || ''), stale.err || '');

  // CROSS-TAB uid collision: B's input uid ('e2') is also a VALID uid on C —
  // but on C it names the <a href=/page2> link. click(pageId:C, uid=B's input)
  // silently clicks C's link and navigates C. No error possible: frameMap is
  // per-tab and the uid exists in C's own namespace.
  const colliding = inputUid; // 'e2' = B's first textbox = C's link
  const cUrlBefore = (await s1.call('evaluate_script', { pageId: C, function: '()=>location.href' })).sc?.result;
  const xclick = await s1.call('click', { pageId: C, uid: colliding });
  const cUrlAfter = (await s1.call('evaluate_script', { pageId: C, function: '()=>location.href' })).sc?.result;
  if (!xclick.isError) {
    const navigated = cUrlAfter !== cUrlBefore;
    note('medium',
      'uid namespaces collide across tabs: a uid minted on tab B is also a VALID uid on tab C — click(pageId=C, uid=B\'s input) succeeds silently and hits C\'s element (navigated C to ' + cUrlAfter + ')',
      `uid="${colliding}" click via=${xclick.sc?.via} C.url ${cUrlBefore} -> ${cUrlAfter}`);
    ok('P2 cross-tab uid silently hits C element (collision documented)', navigated, `uid=${colliding} nav=${navigated}`);
  } else {
    ok('P2 cross-tab uid rejected', true, xclick.err);
  }

  // Never-snapshotted tab: no frameMap entry -> guard can't fire, DOM lookup fails.
  const nh = await s1.call('new_page', { url: `${L}/a`, background: true });
  const H = nh.sc && nh.sc.pageId; myTabs.add(H);
  const noSnap = await s1.call('click', { pageId: H, uid: 'e1' });
  ok('P2 click on never-snapshotted tab errors', noSnap.isError && /not found|Cannot access/.test(noSnap.err || ''), noSnap.err || '');
  await s1.call('close_page', { pageId: H }); myTabs.delete(H);
  console.log(`  P2 done in ${ms(t)}ms`);
} catch (e) { ok('P2 threw', false, String(e && e.message || e)); }

// ============================== P3 — failure recovery =====================
console.log('\n-- P3 failure recovery --');
try {
  const t = performance.now();
  const B = T.B;
  // 1) page-side error
  const bad = await s1.call('evaluate_script', { pageId: B, function: "()=>{throw new Error('boom-15')}" });
  ok('P3 throwing fn -> isError', bad.isError && /boom-15/.test(bad.err || ''), `${Math.round(bad.ms)}ms ${bad.err || ''}`);
  const after1 = await s1.call('list_pages', {});
  ok('P3 session valid after page-side error', !after1.isError && (after1.sc?.items || []).length > 0, `${Math.round(after1.ms)}ms`);

  // 2) 8s-promise fn — awaited, timed-out, or truncated?
  {
    const t2 = performance.now();
    const slow = await s1.call('evaluate_script', { pageId: B, function: "()=>new Promise(r=>setTimeout(()=>r('done8s'),8000))" }, 30000);
    const d = ms(t2);
    if (d < 3000) {
      note('medium', 'evaluate_script does NOT await user-returned promises on the scripting path — async fn result silently lost while the fn keeps running page-side (CDP fallback path DOES await: awaitPromise:true — inconsistent semantics)', `returned in ${d}ms result=${JSON.stringify(slow.sc?.result)}`);
      ok('P3 8s-promise returns early (result lost)', true, `${d}ms result=${JSON.stringify(slow.sc?.result)}`);
    } else {
      ok('P3 8s-promise awaited ~8s', d >= 7500 && !slow.isError, `${d}ms result=${JSON.stringify(slow.sc?.result)} ${slow.err || ''}`);
    }
    const after2 = await s1.call('list_pages', {});
    ok('P3 session valid after slow eval', !after2.isError, `${Math.round(after2.ms)}ms`);
  }

  // 3) wait_for timeout -> error, then session still fine
  const wf = await s1.call('wait_for', { pageId: B, text: ['___never_present___'], timeout: 2500 });
  ok('P3 wait_for timeout -> error', wf.isError && /timeout waiting/.test(wf.err || ''), `${Math.round(wf.ms)}ms ${wf.err || ''}`);
  const after3 = await s1.call('list_pages', {});
  ok('P3 session valid after wait_for timeout', !after3.isError, `${Math.round(after3.ms)}ms`);

  // 4) call on a closed tab -> error, session survives
  const nd = await s1.call('new_page', { url: `${L}/a`, background: true });
  const D = nd.sc && nd.sc.pageId; myTabs.add(D);
  await s1.call('close_page', { pageId: D }); myTabs.delete(D);
  const dead = await s1.call('evaluate_script', { pageId: D, function: '()=>1' });
  ok('P3 call on dead tab -> error', dead.isError, `${Math.round(dead.ms)}ms ${dead.err || ''}`);
  const after4 = await s1.call('list_pages', {});
  ok('P3 session valid after dead-tab call', !after4.isError, `${Math.round(after4.ms)}ms`);
  console.log(`  P3 done in ${ms(t)}ms`);
} catch (e) { ok('P3 threw', false, String(e && e.message || e)); }

// ============================== P4 — debugger zombie ======================
console.log('\n-- P4 debugger lifecycle: attach -> close tab -> new tab --');
if (await needBridge('P4')) try {
  const t = performance.now();
  const ne = await s1.call('new_page', { url: `${L}/a`, background: true });
  const E = ne.sc && ne.sc.pageId; myTabs.add(E);
  const net1 = await s1.call('list_network_requests', { pageId: E });
  ok('P4 attach+capture on E', !net1.isError, `${Math.round(net1.ms)}ms total=${net1.sc?.total} ${net1.err || ''}`);
  const cl = await s1.call('close_page', { pageId: E }); myTabs.delete(E);
  ok('P4 close tab E with debugger attached', !cl.isError, `${Math.round(cl.ms)}ms`);

  const nf = await s1.call('new_page', { url: `${L}/b`, background: true });
  const F = nf.sc && nf.sc.pageId; myTabs.add(F); T.F = F;
  await delay(400);
  await s1.call('list_network_requests', { pageId: F });            // attach
  await s1.call('navigate_page', { pageId: F, type: 'reload' });    // generate traffic post-attach
  const net2 = await s1.call('list_network_requests', { pageId: F });
  ok('P4 new tab F network capture works (no zombie)', !net2.isError && (net2.sc?.total || 0) >= 1, `${Math.round(net2.ms)}ms total=${net2.sc?.total} ${net2.err || ''}`);
  const det = await s1.call('detach_debugger', { pageId: F });
  ok('P4 detach F', !det.isError && det.sc?.detached === true, `${Math.round(det.ms)}ms detached=${det.sc?.detached}`);
  console.log(`  P4 done in ${ms(t)}ms`);
} catch (e) { ok('P4 threw', false, String(e && e.message || e)); }

// ============================== P5 — modalDialogs / handle_dialog =========
console.log('\n-- P5 modal dialogs --');
if (await needBridge('P5')) try {
  const t = performance.now();
  const ng = await s1.call('new_page', { url: `${L}/a` }); // FOREGROUND so timers/dialogs aren't throttled
  const G = ng.sc && ng.sc.pageId; myTabs.add(G); T.G = G;
  await s1.call('list_network_requests', { pageId: G }); // attach debugger (Page.enable)

  // (a) async alert: evaluate returns, dialog opens -> queued -> hint on next result
  const arm = await s1.call('evaluate_script', { pageId: G, function: "()=>{setTimeout(()=>alert('mcp15-async'),60);return 'armed'}" });
  ok('P5 arm async alert', !arm.isError && arm.sc?.result === 'armed', `${Math.round(arm.ms)}ms ${arm.err || ''}`);
  // poll for the hint (timer may take a moment)
  let hint = null, hintMs = 0;
  for (let i = 0; i < 12 && !hint; i++) {
    await delay(400);
    const r = await s1.call('list_network_requests', { pageId: G });
    hintMs += Math.round(r.ms);
    if ((r.sc?.modalDialogs || []).some(x => /alert/.test(x))) hint = r.sc.modalDialogs;
  }
  ok('P5 next result carries modalDialogs hint', !!hint, JSON.stringify(hint));
  const h1 = await s1.call('handle_dialog', { pageId: G, action: 'accept' });
  ok('P5 handle_dialog accept clears queue', !h1.isError && h1.sc?.handled?.type === 'alert', `${Math.round(h1.ms)}ms ${JSON.stringify(h1.sc?.handled)} ${h1.err || ''}`);
  const clear = await s1.call('list_network_requests', { pageId: G });
  ok('P5 hint gone after accept', !(clear.sc?.modalDialogs || []).length, JSON.stringify(clear.sc?.modalDialogs || null));

  // (b) blocking alert() — evaluate hangs until a CONCURRENT handle_dialog frees it
  const pending = s1.call('evaluate_script', { pageId: G, function: "()=>{alert('mcp15-block');return 'after-alert'}" }, 30000);
  let hint2 = null;
  for (let i = 0; i < 12 && !hint2; i++) {
    await delay(300);
    const r = await s1.call('list_network_requests', { pageId: G });
    if ((r.sc?.modalDialogs || []).some(x => /mcp15-block/.test(x))) hint2 = r.sc.modalDialogs;
  }
  ok('P5 concurrent call responsive while evaluate blocked + shows hint', !!hint2, JSON.stringify(hint2));
  const h2 = await s1.call('handle_dialog', { pageId: G, action: 'accept' });
  const blockedRes = await pending;
  ok('P5 blocked evaluate resumed after accept', !blockedRes.isError && blockedRes.sc?.result === 'after-alert', `eval=${Math.round(blockedRes.ms)}ms handle=${Math.round(h2.ms)}ms result=${blockedRes.sc?.result} ${blockedRes.err || ''}`);
  if (!blockedRes.isError) {
    note('info', 'alert() blocks evaluate_script indefinitely (no page-side timeout); a concurrent handle_dialog on the SAME session unblocks it — bridge+extension pipeline stays responsive under a wedged call', `blocked eval completed in ${Math.round(blockedRes.ms)}ms`);
  }

  const det = await s1.call('detach_debugger', { pageId: G });
  ok('P5 detach G', !det.isError, `${Math.round(det.ms)}ms`);
  console.log(`  P5 done in ${ms(t)}ms`);
} catch (e) { ok('P5 threw', false, String(e && e.message || e)); }

// ============================== P6 — session churn ========================
console.log('\n-- P6 session churn (10 create/abandon + call + DELETE) --');
if (await needBridge('P6')) try {
  const t = performance.now();
  const base = (await status()).sessions;
  const sess = [];
  for (let i = 0; i < 10; i++) sess.push(await mk('adv-15-churn-' + i));
  const okd = sess.filter(s => s.ok);
  ok('P6 10 sessions created', okd.length === 10, `init ok=${okd.length}/10 firstErr=${sess.find(s => !s.ok)?.error || ''}`);
  const calls = await Promise.all(okd.map(s => s.call('list_pages', {})));
  ok('P6 all sessions call tools', calls.every(c => !c.isError), `ok=${calls.filter(c => !c.isError).length}/${okd.length}`);
  const mid = (await status()).sessions;
  ok('P6 sessions counted (>=base+10, shared env tolerant)', mid >= base + okd.length, `baseline=${base} mid=${mid}`);
  for (const s of okd) await closeSession(s.sid);
  const after = (await status()).sessions;
  ok('P6 sessions released after DELETE', after <= mid - okd.length + 2, `after=${after} (mid=${mid})`);
  note('low', 'abandoned sessions linger until the 45min TTL sweep (60s interval) — no LRU below MAX_SESSIONS=50; GET / sessions grows under create/abandon churn', `baseline=${base} mid=${mid} after=${after}`);
  console.log(`  P6 done in ${ms(t)}ms`);
} catch (e) { ok('P6 threw', false, String(e && e.message || e)); }

// ============================== P7 — stress-lite ==========================
console.log('\n-- P7 stress-lite: 3 sessions x {snapshot -> click -> screenshot} --');
if (await needBridge('P7')) try {
  const t = performance.now();
  const loops = await Promise.all([0, 1, 2].map(async (k) => {
    const s = await mk('adv-15-stress-' + k);
    const errs = []; const tms = {};
    const np = await s.call('new_page', { url: `${L}/form`, background: true });
    const T = np.sc && np.sc.pageId; myTabs.add(T);
    for (let i = 0; i < 3; i++) {
      let tt = performance.now();
      const sn = await s.call('take_snapshot', { pageId: T });
      const u = findUid(sn.sc?.lines, /link|tog/);
      if (sn.isError || !u) errs.push(`snap${i}:${sn.err || 'no uid'}`);
      tms['snap' + i] = ms(tt);
      tt = performance.now();
      const ck = await s.call('click', { pageId: T, uid: u || 'e1' });
      if (ck.isError) errs.push(`click${i}:${ck.err}`);
      tms['click' + i] = ms(tt);
      tt = performance.now();
      const sh = await s.call('take_screenshot', { pageId: T, format: 'jpeg', quality: 40, filePath: `${OUT}/adv15-s${k}-${i}.jpg` });
      if (sh.isError) errs.push(`shot${i}:${sh.err}`);
      tms['shot' + i] = ms(tt);
    }
    return { k, T, sid: s.sid, errs, tms };
  }));
  for (const Lo of loops) {
    ok(`P7 session ${Lo.k} loop clean`, Lo.errs.length === 0, `errs=${JSON.stringify(Lo.errs)} tms=${JSON.stringify(Lo.tms)}`);
  }
  const contention = loops.flatMap(L => L.errs).filter(e => !/no session/.test(e));
  if (contention.length) note('high', 'contention errors under 3-session parallel load', JSON.stringify(contention));
  console.log(`  P7 done in ${ms(t)}ms`);
} catch (e) { ok('P7 threw', false, String(e && e.message || e)); }

// ============================== P8 — cleanup ==============================
console.log('\n-- P8 cleanup --');
{
  for (const Tb of [...myTabs]) {
    try { await s1.call('detach_debugger', { pageId: Tb }); } catch {}
  }
  for (const Tb of [...myTabs]) {
    const r = await s1.call('close_page', { pageId: Tb });
    if (!r.isError && !r.err) myTabs.delete(Tb);
  }
  ok('P8 all my tabs closed', myTabs.size === 0, `remaining=${[...myTabs]}`);
  for (const sid of [...mySessions]) await closeSession(sid);
  const fin = await status();
  ok('P8 GET / healthy', fin.extensionConnected === true, JSON.stringify(fin));
}

// ============================== report ====================================
lserver.close();
console.log('\n================ REPORT ================');
const fails = checks.filter(c => !c.ok);
console.log(`checks: ${checks.length - fails.length}/${checks.length} passed, total wall ${ms(t0all)}ms`);
if (fails.length) { console.log('FAILED:'); for (const f of fails) console.log('  -', f.name); }
console.log('\nfindings:');
for (const f of findings) console.log(`  [${f.severity}] ${f.finding}\n      evidence: ${f.evidence}`);
process.exitCode = fails.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();
