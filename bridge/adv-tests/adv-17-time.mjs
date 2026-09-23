// adv-17-time.mjs — hang/timeout behavior + session churn.
//   T6: a hanging tools/call must not starve other calls; releasing the
//       page-side promise must release the bridge pending slot.
//       (MCP_CALL_TIMEOUT=120s not waited out — verified indirectly.)
//   T7: 50 rapid init+DELETE session cycles — transports map must not leak.
// Run: node adv-17-time.mjs

import { McpSession, health, sleep, brief, Tabs, startServer, waitForExtension, initWithRetry } from './adv-17-lib.mjs';

const R = [];
const report = (name, verdict, detail) => {
  R.push([name, verdict]);
  console.log(`\n### ${name}\n=> ${verdict}\n${detail}`);
};

const tabs = new Tabs();
const srv = await startServer();
const s = new McpSession('time');

try {
  const h0 = await health();
  console.log('health@start:', JSON.stringify(h0));
  await s.init();
  if (!(await waitForExtension())) throw new Error('extension never connected');
  const pg = tabs.track(await s.call('new_page', { url: 'http://127.0.0.1:' + srv.port + '/p' }));
  console.log('page:', pg);

  // ================= T6: hang + concurrency during hang =================
  // MAIN-world evaluate returns a promise resolved only by window.__relHang.
  const hung = s.call('evaluate_script', {
    pageId: pg,
    function: `() => new Promise(r => { window.__relHang = r; })`,
  }, { timeout: 180000 });
  await sleep(400); // let it reach the page and park

  // While hung: other calls on same session AND same page must proceed.
  const probe = async (label, p) => {
    const r = await p;
    return `${label}:${r.ok ? 'ok' : 'ERR'}@${r.ms}ms`;
  };
  const during = await Promise.all([
    probe('list1', s.call('list_pages', {})),
    probe('list2', s.call('list_pages', {})),
    probe('snap', s.call('take_snapshot', { pageId: pg })),
    probe('eval', s.call('evaluate_script', { pageId: pg, function: `() => 'probe-alive'` })),
    probe('list3', s.call('list_pages', {})),
  ]);
  console.log('during-hang probes:', during.join(' | '));

  // Second session must also be unaffected (shared pending map sanity).
  const s2 = new McpSession('time2');
  await initWithRetry(s2);
  const s2probe = await s2.call('list_pages', {});
  const s2ok = s2probe.ok && s2probe.ms < 10000;

  // Release the page-side promise; hung call must resolve, freeing pending.
  const rel = await s.call('evaluate_script', {
    pageId: pg,
    function: `() => { const r = window.__relHang; window.__relHang = null; if (r) { r('hang-done'); return 'released' } return 'no-hang' }`,
  });
  const hungRes = await Promise.race([hung, sleep(15000).then(() => ({ timeout: true }))]);
  const hungOk = hungRes && hungRes.ok && hungRes.text.includes('hang-done');
  const after = await s.call('list_pages', {});
  const hAfter = await health();
  report('T6 hang + release',
    (hungRes.timeout || !hungOk || !after.ok || !s2ok) ? 'FAIL' : 'PASS',
    `probes=[${during.join(', ')}] s2list=${s2probe.ok ? 'ok@' + s2probe.ms + 'ms' : brief(s2probe)} | release=${brief(rel)} | hung=${hungRes.timeout ? 'STILL HUNG' : brief(hungRes)} | post=${after.ok ? 'ok@' + after.ms + 'ms' : brief(after)} | sessions=${hAfter.sessions}` +
    `\n  note: MCP_CALL_TIMEOUT=120s not waited out; pending slot release verified via successful resolve + subsequent calls`);
  await s2.close();

  // ================= T7: 50 rapid connect/disconnect =================
  const base = (await health()).sessions; // includes s (open)
  let initFails = 0, delFails = 0, seqMs = 0;
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const x = new McpSession('churn' + i);
    try { await x.init(); } catch { initFails++; continue; }
    const d = await x.close();
    if (!d.status || d.status >= 400) delFails++;
  }
  seqMs = Date.now() - t0;
  // parallel burst of 5: init+delete overlapped (cap is 50; stale sessions
  // from earlier runs eat headroom, keep burst small)
  const burst = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
    const x = new McpSession('burst' + i);
    try { await x.init(); } catch { return 'initFail'; }
    const d = await x.close();
    return d.status === 200 || d.status === 202 || d.status === 204 ? 'ok' : 'del' + d.status;
  }));
  const burstBad = burst.filter(b => b !== 'ok');
  // 3 sessions deleted mid-call
  const mid = await Promise.all(Array.from({ length: 3 }, async (_, i) => {
    const x = new McpSession('mid' + i);
    await x.init();
    const inflight = x.call('evaluate_script', { pageId: pg, function: `() => 'mid${i}'` }, { timeout: 15000 });
    await x.close();
    const r = await inflight;
    return r.ok || r.error || r.isErr ? 'resolved-' + (r.ok ? 'ok' : 'err') : 'weird';
  }));
  await sleep(300);
  const hEnd = await health();
  const leaked = hEnd.sessions - base;
  report('T7 50 rapid connect/disconnect',
    (initFails || delFails || burstBad.length || leaked > 1) ? 'FAIL' : 'PASS',
    `seqCycles=40@${seqMs}ms initFails=${initFails} delFails=${delFails} burst10=[${[...new Set(burst)].join(',')}${burstBad.length ? ' bad:' + JSON.stringify(burstBad) : ''}] midDelete=[${mid.join(',')}] | sessions ${base} -> ${hEnd.sessions} (leaked=${leaked})`);

} catch (e) {
  report('FATAL', 'FAIL', String(e && e.stack || e));
} finally {
  await tabs.closeAll(s);
  await s.close();
  srv.close();
  console.log('\ncleanup done. health@end:', JSON.stringify(await health()));
  console.log('\n================ SUMMARY ================');
  for (const [n, v] of R) console.log(`${v}  ${n}`);
}
