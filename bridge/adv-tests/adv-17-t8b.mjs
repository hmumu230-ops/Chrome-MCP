// adv-17-t8b.mjs — T8 follow-up: 10 parallel clicks on same uid via SYNTHETIC
// path (no debugger attached) vs CDP path. Count actual page-side clicks.
import { McpSession, health, sleep, brief, uidOf, Tabs, startServer, waitForExtension, initWithRetry } from './adv-17-lib.mjs';

const srv = await startServer();
const U = 'http://127.0.0.1:' + srv.port;
const s = new McpSession('t8b');
const tabs = new Tabs();
await initWithRetry(s);
await waitForExtension();

const COUNTERS = `() => 'ca=' + window.__ca + ' cb=' + window.__cb`;

try {
  // ---- synthetic path: fresh tab, debugger NOT attached ----
  const pg = tabs.track(await s.call('new_page', { url: U + '/p?t8syn=1&swap=0' }));
  await sleep(700);
  const snap = await s.call('take_snapshot', { pageId: pg });
  const uid = uidOf(snap, /button "A"/);
  console.log('synthetic-path uid:', uid);
  const rs = await Promise.all(Array.from({ length: 10 }, () => s.call('click', { pageId: pg, uid })));
  const okN = rs.filter(r => r.ok).length;
  const vias = {}; rs.forEach(r => { const v = (r.sc && r.sc.via) || 'ERR'; vias[v] = (vias[v] || 0) + 1; });
  const c = await s.call('evaluate_script', { pageId: pg, function: COUNTERS });
  console.log(`SYNTHETIC: ok=${okN}/10 vias=${JSON.stringify(vias)} counters=${c.text.replace(/\s+/g, ' ')}`);

  // ---- cdp path: attach debugger (verbose snapshot), then 10 parallel ----
  await s.call('take_snapshot', { pageId: pg, verbose: true });
  const snap2 = await s.call('take_snapshot', { pageId: pg });
  const uid2 = uidOf(snap2, /button "A"/);
  const rs2 = await Promise.all(Array.from({ length: 10 }, () => s.call('click', { pageId: pg, uid: uid2 })));
  const okN2 = rs2.filter(r => r.ok).length;
  const vias2 = {}; rs2.forEach(r => { const v = (r.sc && r.sc.via) || 'ERR'; vias2[v] = (vias2[v] || 0) + 1; });
  const c2 = await s.call('evaluate_script', { pageId: pg, function: COUNTERS });
  console.log(`CDP:       ok=${okN2}/10 vias=${JSON.stringify(vias2)} counters=${c2.text.replace(/\s+/g, ' ')}`);

  // ---- cdp again, sequential control ----
  const snap3 = await s.call('take_snapshot', { pageId: pg });
  const uid3 = uidOf(snap3, /button "A"/);
  for (let i = 0; i < 5; i++) await s.call('click', { pageId: pg, uid: uid3 });
  const c3 = await s.call('evaluate_script', { pageId: pg, function: COUNTERS });
  console.log(`CDP seq +5: counters=${c3.text.replace(/\s+/g, ' ')}`);
} finally {
  await tabs.closeAll(s);
  await s.close();
  srv.close();
}
console.log('done');
