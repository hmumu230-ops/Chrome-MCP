// adv-17-conc.mjs — concurrency tests on the MCP layer.
//   T1: 50 parallel tools/call on ONE session — response/id matching, cross-talk
//   T4: 20 parallel new_page — unique pageIds, all listed
//   T5: 10 parallel MCP sessions — isolation, correct routing
// Run: node adv-17-conc.mjs   (Windows node; bridge at 127.0.0.1:7890)

import { McpSession, health, sleep, brief, Tabs, startServer, waitForExtension, initWithRetry } from './adv-17-lib.mjs';

const R = [];
const report = (name, verdict, detail) => {
  R.push([name, verdict]);
  console.log(`\n### ${name}\n=> ${verdict}\n${detail}`);
};

const tabs = new Tabs();
const sessions = [];
const srv = await startServer();
const U = 'http://127.0.0.1:' + srv.port + '/p';
console.log('test server:', U);

try {
  const h0 = await health();
  console.log('health@start:', JSON.stringify(h0));

  // ---- setup: one content page for eval/snapshot calls ----
  const s0 = new McpSession('conc');
  sessions.push(s0);
  await initWithRetry(s0);
  if (!(await waitForExtension())) throw new Error('extension never connected');
  const pg = tabs.track(await s0.call('new_page', { url: U }));
  await s0.call('evaluate_script', {
    pageId: pg,
    function: `() => { document.body.innerHTML='<h1>adv17-conc</h1><button id=b>Btn</button><a href="#x">Lnk</a>'; return 'built' }`,
  });
  console.log('test page:', pg);

  // ================= T1: 50 parallel calls on ONE session =================
  // Every response must carry the request's JSON-RPC id; eval responses must
  // contain THEIR token; new_page pageIds must be unique.
  const N_EVAL = 15, N_LIST = 10, N_SNAP = 10, N_NEW = 15;
  const t1calls = [];
  for (let i = 0; i < N_EVAL; i++)
    t1calls.push({ kind: 'eval', i, p: s0.call('evaluate_script', { pageId: pg, function: `() => 'tok-${i}'` }) });
  for (let i = 0; i < N_LIST; i++)
    t1calls.push({ kind: 'list', i, p: s0.call('list_pages', {}) });
  for (let i = 0; i < N_SNAP; i++)
    t1calls.push({ kind: 'snap', i, p: s0.call('take_snapshot', { pageId: pg }) });
  for (let i = 0; i < N_NEW; i++)
    t1calls.push({ kind: 'new', i, p: s0.call('new_page', { url: U + '?n=' + i, background: true }) });

  const t1 = await Promise.all(t1calls.map(c => c.p));
  const t1idMismatch = t1calls.filter((c, k) => t1[k].resId !== t1[k].reqId);
  const t1evalBad = t1calls.filter((c, k) => c.kind === 'eval' && !(t1[k].ok && t1[k].text.includes(`tok-${c.i}`)));
  const t1listBad = t1calls.filter((c, k) => c.kind === 'list' && !(t1[k].ok && (Array.isArray(t1[k].sc && t1[k].sc.items) || t1[k].text.includes('pageId'))));
  const t1snapBad = t1calls.filter((c, k) => c.kind === 'snap' && !(t1[k].ok && Array.isArray(t1[k].sc && t1[k].sc.lines)));
  const newIds = t1calls.filter(c => c.kind === 'new').map((c, k) => null);
  const t1newIds = [];
  const t1newBad = [];
  t1calls.forEach((c, k) => {
    if (c.kind !== 'new') return;
    const p = t1[k].sc && t1[k].sc.pageId;
    if (!t1[k].ok || !Number.isInteger(p)) t1newBad.push({ i: c.i, r: brief(t1[k]) });
    else { t1newIds.push(p); tabs.mine.add(p); }
  });
  const dupIds = t1newIds.filter((v, i) => t1newIds.indexOf(v) !== i);
  const maxMs = Math.max(...t1.map(r => r.ms));
  report('T1 50-parallel single session',
    (t1idMismatch.length || t1evalBad.length || t1listBad.length || t1snapBad.length || t1newBad.length || dupIds.length) ? 'FAIL' : 'PASS',
    `responses=${t1.length} idMismatch=${t1idMismatch.length} evalBad=${t1evalBad.length} listBad=${t1listBad.length} snapBad=${t1snapBad.length} newBad=${t1newBad.length} dupPageIds=${dupIds.length} maxMs=${maxMs}` +
    (t1evalBad.length ? '\n  evalBad: ' + JSON.stringify(t1evalBad.map(c => ({ i: c.i }))) : '') +
    (t1newBad.length ? '\n  newBad: ' + JSON.stringify(t1newBad) : '') +
    (t1idMismatch.length ? '\n  idMismatch: ' + JSON.stringify(t1idMismatch.map(c => ({ kind: c.kind, i: c.i }))) : ''));

  // ================= T4: 20 parallel new_page =================
  const t4 = await Promise.all(
    Array.from({ length: 20 }, (_, i) => s0.call('new_page', { url: U + '?t4=' + i, background: true }))
  );
  const t4ids = [];
  const t4bad = [];
  for (const r of t4) {
    const p = r.sc && r.sc.pageId;
    if (!r.ok || !Number.isInteger(p)) t4bad.push(brief(r));
    else { t4ids.push(p); tabs.mine.add(p); }
  }
  const t4dups = t4ids.filter((v, i) => t4ids.indexOf(v) !== i);
  const lp = await s0.call('list_pages', {});
  const listed = new Set(((lp.sc && lp.sc.items) || []).map(t => t.pageId));
  const missing = t4ids.filter(p => !listed.has(p));
  report('T4 20-parallel new_page',
    (t4bad.length || t4dups.length || missing.length) ? 'FAIL' : 'PASS',
    `created=${t4ids.length} bad=${t4bad.length} dups=${t4dups.length} missingFromList=${missing.length}` +
    (t4bad.length ? '\n  bad: ' + JSON.stringify(t4bad) : '') +
    (missing.length ? '\n  missing: ' + JSON.stringify(missing) : ''));

  // ================= T5: N sessions, concurrent calls =================
  // (cap is 50; pre-existing stale sessions may eat headroom — tolerate 503s)
  const hBefore = await health();
  const WANT = Math.min(10, Math.max(3, 48 - (hBefore.sessions || 0)));
  const initRes = await Promise.all(Array.from({ length: WANT }, async (_, k) => {
    const s = new McpSession('iso' + k);
    try { await initWithRetry(s); sessions.push(s); return s; }
    catch (e) { return { k, initFail: String(e).slice(0, 120) }; }
  }));
  const ss = initRes.filter(x => x instanceof McpSession);
  const initFails = initRes.filter(x => !(x instanceof McpSession));
  const sids = ss.map(s => s.sid);
  const sidDups = sids.filter((v, i) => sids.indexOf(v) !== i);
  const hDuring = await health();

  // Each session: its own page + eval token + list_pages, all in flight together.
  const t5 = await Promise.all(ss.map(async (s, k) => {
    const np = await s.call('new_page', { url: U + '?s5=' + k, background: true });
    const p = np.sc && np.sc.pageId;
    if (p) tabs.mine.add(p);
    const ev = await s.call('evaluate_script', { pageId: p, function: `() => 'sess-${k}-token'` });
    const lp2 = await s.call('list_pages', {});
    return { k, sid: s.sid, np, ev, lp2 };
  }));
  const t5bad = t5.filter(r =>
    !(r.np.ok && r.ev.ok && r.lp2.ok &&
      r.ev.text.includes(`sess-${r.k}-token`) &&
      r.ev.resId === r.ev.reqId && r.np.resId === r.np.reqId));
  // cross-session leak probe: a marker written on the shared page by session 0
  // must not appear when read via another session's call (page state is shared
  // by design; session state is not).
  await s0.call('evaluate_script', { pageId: pg, function: `() => { window.__adv17_marker = 'from-s0'; return 1 }` });
  const leak = await Promise.all(ss.map((s, k) =>
    s.call('evaluate_script', { pageId: pg, function: `() => window.__adv17_marker` })));
  const leakBad = leak.filter(r => !(r.ok && r.text.includes('from-s0'))); // shared page: read should succeed & match
  report('T5 parallel sessions',
    (sidDups.length || t5bad.length || leakBad.length) ? 'FAIL' : 'PASS',
    `wanted=${WANT} got=${ss.length} initFails=${initFails.length} sidDups=${sidDups.length} badCalls=${t5bad.length} sharedPageReads=${leakBad.length} ` +
    `health.sessions ${hBefore.sessions} -> ${hDuring.sessions}` +
    (initFails.length ? '\n  initFails: ' + JSON.stringify(initFails) : '') +
    (t5bad.length ? '\n  bad: ' + JSON.stringify(t5bad.map(r => ({ k: r.k, np: brief(r.np), ev: brief(r.ev), lp: brief(r.lp2) }))) : ''));

} catch (e) {
  report('FATAL', 'FAIL', String(e && e.stack || e));
} finally {
  // ---- cleanup: close my tabs, delete sessions ----
  const s0 = sessions[0];
  if (s0) await tabs.closeAll(s0);
  srv.close();
  await Promise.all(sessions.map(s => s.close()));
  const hEnd = await health();
  console.log('\ncleanup done. health@end:', JSON.stringify(hEnd));
  console.log('\n================ SUMMARY ================');
  for (const [n, v] of R) console.log(`${v}  ${n}`);
}
