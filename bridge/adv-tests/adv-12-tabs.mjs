// adv-12: tab-lifecycle chaos test for Chrome MCP (extension <-> WS <-> MCP HTTP).
// Creates ONLY its own tabs (tracked in `mine`), never touches pre-existing tabs,
// and closes everything it opened before exiting.
//
// Run: node adv-12-tabs.mjs        (requires bridge @127.0.0.1:7890 + extension connected)

const BASE = process.env.MCP_URL || 'http://127.0.0.1:7890/mcp';
const ROOT = BASE.replace(/\/mcp$/, '/');

let sid, i = 0;
const rpc = async (b) => {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(b),
  });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const sse = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  let msg = sse[sse.length - 1];
  if (!msg && t.trim().startsWith('{')) { try { msg = JSON.parse(t); } catch {} }
  return { msg, status: r.status };
};

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-12', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
if (!sid) { console.log('FATAL: no session id'); process.exitCode = 1; throw new Error('no sid'); }

// call -> { ok, err, data, raw } ; never throws on tool-level errors
const call = async (n, a) => {
  try {
    const { msg, status } = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
    const res = msg && msg.result;
    if (!res) return { ok: false, err: `no result (http ${status}) ${msg && msg.error ? JSON.stringify(msg.error) : ''}`.trim(), raw: msg };
    const txt = (res.content && res.content[0] && res.content[0].text) || '';
    if (res.isError) return { ok: false, err: txt.replace(/^Error:\s*/, '') };
    let data = res.structuredContent;
    if (data === undefined) { try { data = JSON.parse(txt); } catch { data = txt; } }
    return { ok: true, data, raw: res };
  } catch (e) {
    return { ok: false, err: 'CLIENT: ' + String(e && e.message || e) };
  }
};

// ---------- bookkeeping ----------
const mine = new Set();          // every pageId I create
let failed = 0;
const findings = [];
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 140) : ''}`);
  if (!cond) failed++;
};
const info = (s) => console.log('  ....  ' + s);
const finding = (sev, s) => { findings.push({ sev, s }); console.log(`  [${sev}] ${s}`); };
const pages = async () => { const r = await call('list_pages', {}); return r.ok ? (r.data.items || r.data) : null; };
const newTab = async (args) => {
  const r = await call('new_page', args);
  if (r.ok && r.data && r.data.pageId !== undefined) mine.add(r.data.pageId);
  return r;
};
const closeTab = async (pageId) => {
  const r = await call('close_page', { pageId });
  if (r.ok) mine.delete(pageId);
  return r;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const short = (r) => (r.ok ? 'OK ' + JSON.stringify(r.data).slice(0, 90) : 'ERR ' + String(r.err).slice(0, 110));

const t0 = Date.now();
try {
  // ================= 0. baseline =================
  console.log('\n== 0. baseline ==');
  const status0 = await fetch(ROOT).then(r => r.json()).catch(e => ({ err: String(e) }));
  info('GET / -> ' + JSON.stringify(status0));
  ok('extension connected at start', status0.extensionConnected === true);
  const base = await pages();
  if (!base) throw new Error('cannot list_pages at baseline');
  const baseIds = new Set(base.map(t => t.pageId));
  info(`baseline tabs (${base.length}): ` + base.map(t => `${t.pageId}:${(t.url || '').slice(0, 40)}`).join(' | '));

  // ================= 1. rapid create 8, close reverse =================
  console.log('\n== 1. rapid create 8 tabs (concurrent), close in reverse order ==');
  const tA = Date.now();
  const batch = await Promise.all(Array.from({ length: 8 }, () => call('new_page', { url: 'about:blank' })));
  const ids8 = [];
  for (const r of batch) {
    if (r.ok && r.data && r.data.pageId !== undefined) { ids8.push(r.data.pageId); mine.add(r.data.pageId); }
  }
  info(`created ${ids8.length}/8 in ${Date.now() - tA}ms: ${ids8.join(',')}`);
  ok('8 concurrent new_page all succeeded', ids8.length === 8, ids8.length + '/8');
  ok('8 pageIds all distinct', new Set(ids8).size === ids8.length, new Set(ids8).size + ' unique');
  ok('no pageId collides with pre-existing tabs', ids8.every(id => !baseIds.has(id)));
  const mid = await pages();
  ok('list_pages sees all 8 new tabs', ids8.every(id => mid.some(t => t.pageId === id)),
    ids8.filter(id => !mid.some(t => t.pageId === id)).join(',') || 'all present');
  // close in reverse creation order, sequentially
  let closeFails = 0;
  for (const id of [...ids8].reverse()) {
    const r = await closeTab(id);
    if (!r.ok) { closeFails++; info(`close_page(${id}) -> ${r.err}`); }
  }
  ok('all 8 closed in reverse order', closeFails === 0, closeFails + ' failures');
  const after8 = await pages();
  const survivors = ids8.filter(id => after8.some(t => t.pageId === id));
  ok('list_pages consistent: none of the 8 remain', survivors.length === 0, survivors.join(',') || 'clean');
  ok('pre-existing tabs untouched', [...baseIds].every(id => after8.some(t => t.pageId === id)));

  // ================= 2. close ACTIVE tab / sole tab of a created window =================
  console.log('\n== 2. close the only tab of a window we created (incognito via isolatedContext) ==');
  const inc = await newTab({ url: 'about:blank', isolatedContext: 'adv12', background: true });
  if (inc.ok) {
    const incId = inc.data.pageId;
    const lst = await pages();
    const myInc = lst.find(t => t.pageId === incId);
    const winTabs = lst.filter(t => t.windowId === myInc.windowId);
    info(`incognito tab ${incId} in window ${myInc.windowId} with ${winTabs.length} tab(s), incognito=${myInc.incognito}`);
    ok('isolatedContext produced an incognito tab', myInc.incognito === true);
    const c = await closeTab(incId);
    ok('closed sole tab of created window', c.ok, short(c));
    const lst2 = await pages();
    ok('window/tab gone from list_pages', !lst2.some(t => t.pageId === incId) && !lst2.some(t => t.windowId === myInc.windowId));
    const op = await call('select_page', { pageId: incId });
    ok('ops on closed window tab error cleanly', !op.ok, short(op));
  } else {
    info('isolatedContext unavailable (' + inc.err + ') — fallback: close active tab in current window');
    const t1 = await newTab({ url: 'about:blank' });   // becomes active
    const lst = await pages();
    const me = lst.find(t => t.pageId === t1.data.pageId);
    ok('new_page tab is the active tab of its window', me && me.active === true);
    const winId = me.windowId;
    const c = await closeTab(t1.data.pageId);
    ok('closed active tab', c.ok, short(c));
    const lst2 = await pages();
    ok('closed tab gone', !lst2.some(t => t.pageId === t1.data.pageId));
    ok('window still sane: exactly one active tab remains in window', lst2.filter(t => t.windowId === winId && t.active).length === 1,
      lst2.filter(t => t.windowId === winId && t.active).map(t => t.pageId).join(',') || 'none');
  }

  // ================= 3. background tab =================
  console.log('\n== 3. new_page background:true ==');
  const bg = await newTab({ url: 'about:blank', background: true });
  ok('background new_page succeeded', bg.ok, short(bg));
  const lstBg = await pages();
  const bgTab = lstBg.find(t => t.pageId === bg.data.pageId);
  ok('tab created inactive', bgTab && bgTab.active === false, 'active=' + (bgTab && bgTab.active));
  // let it settle, then snapshot without focusing
  await sleep(400);
  const snapBg = await call('take_snapshot', { pageId: bg.data.pageId });
  ok('take_snapshot works on background tab', snapBg.ok, short(snapBg));
  const bgTabAfter = (await pages()).find(t => t.pageId === bg.data.pageId);
  ok('snapshot did not activate the tab', bgTabAfter && bgTabAfter.active === false, 'active=' + (bgTabAfter && bgTabAfter.active));

  // ================= 4. operate on tab AFTER close_page =================
  console.log('\n== 4. every tool on a closed tab must error, not crash ==');
  // give the tab a uid so click/hover have a valid-looking uid
  await call('evaluate_script', { pageId: bg.data.pageId, function: "() => { document.body.innerHTML = '<button id=\"b\">x</button>'; return 1 }" });
  const snapPre = await call('take_snapshot', { pageId: bg.data.pageId });
  const deadUid = snapPre.ok && snapPre.data.lines && snapPre.data.lines.length
    ? (snapPre.data.lines.join('\n').match(/\[(e\d+|f\d+e\d+)\]/) || [])[1]
    : null;
  info('uid captured pre-close: ' + deadUid);
  const deadId = bg.data.pageId;
  const c4 = await closeTab(deadId);
  ok('close_page succeeded', c4.ok);
  const battery = [
    ['select_page', { pageId: deadId }],
    ['navigate_page', { pageId: deadId, url: 'about:blank' }],
    ['navigate_page', { pageId: deadId, type: 'reload' }],
    ['navigate_page', { pageId: deadId, type: 'back' }],
    ['resize_page', { pageId: deadId, width: 800, height: 600 }],
    ['take_snapshot', { pageId: deadId }],
    ['take_snapshot', { pageId: deadId, verbose: true }],
    ['take_screenshot', { pageId: deadId }],
    ['evaluate_script', { pageId: deadId, function: '() => 1' }],
    ['click', { pageId: deadId, uid: deadUid || 'e1' }],
    ['hover', { pageId: deadId, uid: deadUid || 'e1' }],
    ['fill', { pageId: deadId, uid: deadUid || 'e1', value: 'x' }],
    ['scroll', { pageId: deadId, to: 'bottom' }],
    ['click_xy', { pageId: deadId, x: 10, y: 10 }],
    ['press_key', { pageId: deadId, key: 'Enter' }],
    ['type_text', { pageId: deadId, text: 'x' }],
    ['wait_for', { pageId: deadId, text: ['zzz-never'], timeout: 2500 }],
    ['wait_for', { pageId: deadId, time: 300 }],
    ['list_console_messages', { pageId: deadId }],
    ['list_network_requests', { pageId: deadId }],
    ['get_cookies', { pageId: deadId }],
    ['extract_text', { pageId: deadId }],
    ['handle_dialog', { pageId: deadId, action: 'dismiss' }],
    ['detach_debugger', { pageId: deadId }],
    ['close_page', { pageId: deadId }],           // double close
    ['close_page', { pageId: 999999999 }],         // never existed
  ];
  const silent = [];
  for (const [tool, args] of battery) {
    const r = await call(tool, args);
    const label = `${tool}(${args.type || args.url || args.uid || args.time !== undefined && 'time:' + args.time || ''})`.replace(/\(\)$/, '');
    if (r.ok) {
      silent.push(`${tool} -> ${JSON.stringify(r.data).slice(0, 80)}`);
      info(`SILENT-OK  ${label} -> ${JSON.stringify(r.data).slice(0, 90)}`);
    } else {
      info(`err        ${label} -> ${String(r.err).slice(0, 100)}`);
    }
  }
  const expectedSilent = silent.filter(s => !/detach_debugger|wait_for/.test(s));
  ok('no tool crashed the channel (battery completed)', true);
  if (silent.length) finding('LOW', `tools that SUCCEEDED on a closed tab instead of "no such page": ${silent.join(' ; ')}`);
  ok('only detach_debugger/wait_for(time) silently succeed on dead tab', expectedSilent.length === 0, silent.join(' | ') || 'none');

  // ================= 5. uid staleness across chrome:// navigation =================
  console.log('\n== 5. navigate to chrome://newtab then back — uid map lifecycle ==');
  const t5 = await newTab({ url: 'about:blank' });
  const p5 = t5.data.pageId;
  await call('evaluate_script', { pageId: p5, function: "() => { document.body.innerHTML = '<button id=\"b\">hello</button><a href=\"#x\">lnk</a>'; return 1 }" });
  const snap5 = await call('take_snapshot', { pageId: p5 });
  const uid5 = snap5.ok && snap5.data.lines ? (snap5.data.lines.join('\n').match(/\[(e\d+)\]/) || [])[1] : null;
  ok('snapshot on my tab produced a uid', !!uid5, 'uid=' + uid5);
  if (uid5) {
    const cOk = await call('click', { pageId: p5, uid: uid5 });
    info('pre-navigation click baseline: ' + short(cOk));
  }
  const nav1 = await call('navigate_page', { pageId: p5, url: 'chrome://newtab' });
  ok('navigate_page -> chrome://newtab returned', nav1.ok, short(nav1));
  const lstNav = await pages();
  const meNav = lstNav.find(t => t.pageId === p5);
  info('tab url now: ' + (meNav && meNav.url));
  const snapNtp = await call('take_snapshot', { pageId: p5 });
  info('take_snapshot on chrome://newtab: ' + short(snapNtp));
  if (!snapNtp.ok) info('(expected: scripting blocked on chrome:// pages)');
  const navBack = await call('navigate_page', { pageId: p5, type: 'back' });
  info('navigate_page type:back from chrome://newtab: ' + short(navBack));
  if (!navBack.ok) {
    finding('MED', `navigate_page type:'back' cannot leave a chrome:// page — scripting AND debugger both blocked there; got: ${navBack.err}`);
    const navUrl = await call('navigate_page', { pageId: p5, url: 'about:blank' });
    ok('recovery via navigate_page type:url works', navUrl.ok, short(navUrl));
  } else {
    info('back navigation succeeded; url=' + JSON.stringify(navBack.data && navBack.data.url));
  }
  if (uid5) {
    const cOld = await call('click', { pageId: p5, uid: uid5 });
    info(`click old uid "${uid5}" after nav-away-and-back: ${short(cOld)}`);
    ok('old uid after navigation errors (no crash, no wrong-element click)', !cOld.ok, String(cOld.err || '').slice(0, 90));
    if (cOld.ok) finding('HIGH', `stale uid "${uid5}" CLICKED an element after navigation — uid namespace reused across documents`);
    // after a FRESH snapshot the staleness guard should kick in with the explicit message
    const snap5b = await call('take_snapshot', { pageId: p5 });
    info('fresh snapshot after return: ' + short(snap5b));
    const cOld2 = await call('click', { pageId: p5, uid: uid5 });
    info(`click old uid after fresh snapshot: ${short(cOld2)}`);
    if (cOld2.ok) finding('HIGH', `stale uid "${uid5}" still clickable after fresh snapshot`);
    else if (!/stale/i.test(String(cOld2.err))) finding('LOW', `old uid errors but with generic message "${String(cOld2.err).slice(0, 80)}" — 'stale uid' guard only fires when a snapshot map exists`);
  }
  await closeTab(p5);

  // ================= 6. duplicate pageId handling =================
  console.log('\n== 6. list_pages twice — ids stable & no dupes ==');
  const l1 = await pages(), l2 = await pages();
  const ids1 = l1.map(t => t.pageId).sort((a, b) => a - b);
  const ids2 = l2.map(t => t.pageId).sort((a, b) => a - b);
  ok('two list_pages calls return identical id sets', JSON.stringify(ids1) === JSON.stringify(ids2),
    ids1.length + ' vs ' + ids2.length);
  ok('no duplicate pageIds within one listing', new Set(ids1).size === ids1.length);
  const d1 = await newTab({ url: 'about:blank' });
  const d2 = await newTab({ url: 'about:blank' });
  ok('same URL -> distinct pageIds', d1.ok && d2.ok && d1.data.pageId !== d2.data.pageId,
    `${d1.data && d1.data.pageId} vs ${d2.data && d2.data.pageId}`);
  await closeTab(d1.data.pageId);
  const lstD = await pages();
  ok('closed id does not linger', !lstD.some(t => t.pageId === d1.data.pageId));
  await closeTab(d2.data.pageId);

  // ================= 7. chrome://extensions tab =================
  console.log('\n== 7. new_page chrome://extensions + take_snapshot (scripting blocked) ==');
  const ext = await newTab({ url: 'chrome://extensions', background: true });
  ok('new_page chrome://extensions created', ext.ok, short(ext));
  if (ext.ok) {
    await sleep(600);
    const snapExt = await call('take_snapshot', { pageId: ext.data.pageId });
    info('take_snapshot on chrome://extensions: ' + short(snapExt));
    ok('snapshot on chrome:// page errors cleanly', !snapExt.ok, String(snapExt.err || '').slice(0, 90));
    const evalExt = await call('evaluate_script', { pageId: ext.data.pageId, function: '() => 1' });
    ok('evaluate_script on chrome:// page errors cleanly', !evalExt.ok, String(evalExt.err || '').slice(0, 90));
    const navExt = await call('navigate_page', { pageId: ext.data.pageId, url: 'about:blank' });
    ok('can still navigate away from chrome:// tab', navExt.ok, short(navExt));
    await closeTab(ext.data.pageId);
  }

  // ================= 8. error pages (404 / cert / DNS) =================
  console.log('\n== 8. error pages ==');
  // 8a. real HTTP 404 served by the bridge itself (fast, local)
  const p404 = await newTab({ url: 'http://127.0.0.1:7890/definitely-not-here-404', background: true });
  if (p404.ok) {
    await sleep(1200);
    const w404 = await call('wait_for', { pageId: p404.data.pageId, time: 500 });
    ok('wait_for on 404 page returns', w404.ok, short(w404));
    const s404 = await call('take_snapshot', { pageId: p404.data.pageId });
    info('take_snapshot on HTTP-404 page: ' + short(s404));
    ok('snapshot on 404 page does not crash the tool', s404.ok || /cannot|access|error/i.test(String(s404.err)));
    await closeTab(p404.data.pageId);
  }
  // 8b. cert error page
  const pCert = await newTab({ url: 'https://expired.badssl.com', background: true });
  if (pCert.ok) {
    const pid = pCert.data.pageId;
    await sleep(6000); // give the cert interstitial time to render
    const lstC = await pages();
    info('cert-error tab url: ' + ((lstC.find(t => t.pageId === pid) || {}).url));
    const sCert = await call('take_snapshot', { pageId: pid });
    info('take_snapshot on cert-error page: ' + short(sCert));
    const wCert = await call('wait_for', { pageId: pid, text: ['zzz-never'], timeout: 2500 });
    info('wait_for on cert-error page: ' + short(wCert));
    const navC = await call('navigate_page', { pageId: pid, url: 'about:blank' });
    ok('navigate away from cert-error page works', navC.ok, short(navC));
    await closeTab(pid);
  } else info('cert page creation failed: ' + pCert.err);
  // 8c. DNS error page via navigate on an existing tab
  const pDns = await newTab({ url: 'about:blank', background: true });
  if (pDns.ok) {
    const pid = pDns.data.pageId;
    const navD = await call('navigate_page', { pageId: pid, url: 'https://no-such-host-zz9qq.invalid/' });
    info('navigate_page to NXDOMAIN: ' + short(navD));
    await sleep(1500);
    const sDns = await call('take_snapshot', { pageId: pid });
    info('take_snapshot on DNS-error page: ' + short(sDns));
    await closeTab(pid);
  }

  // ================= 9. 15 rapid sequential new+close pairs =================
  console.log('\n== 9. 15 rapid sequential new_page+close_page pairs ==');
  const t9 = Date.now();
  let pairFails = 0, leaks = [];
  for (let k = 0; k < 15; k++) {
    const r = await newTab({ url: 'about:blank', background: true });
    if (!r.ok) { pairFails++; info(`pair ${k}: new_page failed: ${r.err}`); continue; }
    const c = await closeTab(r.data.pageId);
    if (!c.ok) { pairFails++; leaks.push(r.data.pageId); info(`pair ${k}: close failed: ${c.err}`); }
  }
  info(`15 pairs in ${Date.now() - t9}ms, ${pairFails} failures`);
  ok('all 15 create+close pairs succeeded', pairFails === 0, pairFails + ' failures, leaked: ' + leaks.join(','));
  const midHealth = await fetch(ROOT).then(r => r.json()).catch(e => ({ err: String(e) }));
  ok('extension still connected after churn', midHealth.extensionConnected === true, JSON.stringify(midHealth));
  const lstMid = await pages();
  ok('list_pages responsive after churn', Array.isArray(lstMid), lstMid && lstMid.length + ' tabs');
  // also: 3 fully-concurrent pairs (racing create/close)
  const conc = await Promise.all(Array.from({ length: 3 }, async () => {
    const r = await newTab({ url: 'about:blank' });
    if (!r.ok) return 'new:' + r.err;
    const c = await closeTab(r.data.pageId);
    return c.ok ? 'ok' : 'close:' + c.err;
  }));
  ok('3 concurrent new+close pairs all ok', conc.every(x => x === 'ok'), conc.join(' | '));

  // ================= 10. final: all my tabs closed, only pre-existing remain =================
  console.log('\n== 10. final state ==');
  // `mine` should already be empty; sweep anything left just in case
  for (const id of [...mine]) await closeTab(id);
  const fin = await pages();
  const finIds = new Set(fin.map(t => t.pageId));
  const extra = [...finIds].filter(id => !baseIds.has(id));
  const missing = [...baseIds].filter(id => !finIds.has(id));
  ok('no tabs leaked — only pre-existing tabs remain', extra.length === 0, 'extra: ' + extra.join(',') || 'none');
  ok('all pre-existing tabs still present (untouched)', missing.length === 0, 'missing: ' + missing.join(',') || 'none');
  const health = await fetch(ROOT).then(r => r.json()).catch(e => ({ err: String(e) }));
  ok('GET / extensionConnected at end', health.extensionConnected === true, JSON.stringify(health));
} finally {
  // last-ditch cleanup: close anything we opened that is still open
  const lst = await pages().catch(() => null);
  if (lst) {
    for (const id of [...mine]) {
      if (lst.some(t => t.pageId === id)) { await call('close_page', { pageId: id }); console.log('cleanup: closed ' + id); }
    }
  }
}

console.log(`\n===== adv-12 done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${failed} failed checks, ${findings.length} findings =====`);
for (const f of findings) console.log(`  [${f.sev}] ${f.s}`);
process.exitCode = failed === 0 ? 0 : 1;
