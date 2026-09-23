// adv-17-race.mjs — same-tab races.
//   T2a: click(uid) ∥ navigate ∥ screenshot, 20x. Click ledger survives nav
//        via window.name; nav target has SWAPPED button layout so a stale
//        CDP coordinate click lands on the OTHER button -> 'B' = wrong-el.
//   T2b: click(uid) ∥ same-doc position swap, 20x — box()->dispatch TOCTOU.
//   T3:  take_snapshot while the page mutates itself every 3ms — torn snap?
//   T8:  10 parallel clicks on the same uid — click accounting.
// Run: node adv-17-race.mjs

import { McpSession, health, sleep, brief, uidOf, Tabs, startServer, waitForExtension, initWithRetry } from './adv-17-lib.mjs';

const R = [];
const report = (name, verdict, detail) => {
  R.push([name, verdict]);
  console.log(`\n### ${name}\n=> ${verdict}\n${detail}`);
};

const tabs = new Tabs();
const srv = await startServer();
const U = 'http://127.0.0.1:' + srv.port;
const s = new McpSession('race');

// toggle A/B positions on the live doc (same-document swap for T2b)
const SWAP = `() => {
  const a = document.getElementById('a'), b = document.getElementById('b');
  if (!a || !b) return 'no-buttons';
  const ta = a.style.top; a.style.top = b.style.top; b.style.top = ta;
  return 'swapped t:' + a.style.top;
}`;
const NAME = `() => window.name`;
const COUNTERS = `() => 'ca=' + window.__ca + ' cb=' + window.__cb`;

// wait until the tab's doc is the freshly committed, armed page
const waitArmed = async (pg, marker) => {
  for (let k = 0; k < 20; k++) {
    const r = await s.call('evaluate_script', { pageId: pg, function: `() => location.search + '|' + !!document.getElementById('a')` });
    if (r.ok && r.text.includes(marker) && r.text.includes('|true')) return true;
    await sleep(150);
  }
  return false;
};

try {
  console.log('health@start:', JSON.stringify(await health()), 'server:', U);
  await initWithRetry(s);
  if (!(await waitForExtension())) throw new Error('extension never connected');
  const pg = tabs.track(await s.call('new_page', { url: U + '/p?r=0&swap=0' }));
  console.log('race page:', pg);
  await waitArmed(pg, 'r=0&');
  await s.call('evaluate_script', { pageId: pg, function: `() => { window.name = ''; return 1 }` });

  const freshUidA = async () => {
    const snap = await s.call('take_snapshot', { pageId: pg });
    return { snap, uid: uidOf(snap, /button "A"/) };
  };

  // ================= T2a: click ∥ navigate ∥ screenshot x20 =================
  let okClicks = 0, errClicks = 0, shotsOk = 0, shotsErr = 0, navOk = 0, navErr = 0;
  const clickVias = {};
  const t2aLog = [];
  for (let i = 0; i < 20; i++) {
    const { uid: uidA } = await freshUidA();
    if (!uidA) { t2aLog.push(`r${i}: NO UID`); continue; }
    const nextUrl = `${U}/p?r=${i + 1}&swap=${(i + 1) % 2}`;
    const [c, n, sh] = await Promise.all([
      s.call('click', { pageId: pg, uid: uidA }),
      s.call('navigate_page', { pageId: pg, url: nextUrl }),
      s.call('take_screenshot', { pageId: pg, format: 'jpeg', quality: 40 }),
    ]);
    const via = (c.sc && c.sc.via) || '-';
    clickVias[via] = (clickVias[via] || 0) + 1;
    if (c.ok) okClicks++; else errClicks++;
    if (n.ok) navOk++; else navErr++;
    if (sh.ok) shotsOk++; else shotsErr++;
    t2aLog.push(`r${i}: click=${c.ok ? 'ok/' + via : 'ERR'} nav=${n.ok ? 'ok' : 'ERR'} shot=${sh.ok ? 'ok' : 'ERR'}` +
      (c.isErr ? ' cerr=' + c.text.slice(0, 90) : '') + (sh.isErr ? ' serr=' + sh.text.slice(0, 90) : '') +
      (n.isErr ? ' nerr=' + n.text.slice(0, 90) : ''));
    await waitArmed(pg, `r=${i + 1}&`);
  }
  const nm = await s.call('evaluate_script', { pageId: pg, function: NAME });
  const ledger = (nm.text.match(/"([AB]*)"/) || [])[1] || '';
  const aHits = (ledger.match(/A/g) || []).length;
  const bHits = (ledger.match(/B/g) || []).length;
  console.log('T2a ledger:', JSON.stringify(ledger), '| okClicks=' + okClicks, 'errClicks=' + errClicks, '| vias:', JSON.stringify(clickVias));
  console.log(t2aLog.join('\n'));
  report('T2a click∥nav∥screenshot x20',
    bHits > 0 ? 'FAIL — wrong-element click(s) landed on B'
      : okClicks > aHits ? 'SUSPECT — click(s) reported ok but hit nothing'
      : 'PASS',
    `ledger="${ledger}" A=${aHits} B=${bHits} | clicks ok=${okClicks} err=${errClicks} | nav ok=${navOk} err=${navErr} | shot ok=${shotsOk} err=${shotsErr} | vias=${JSON.stringify(clickVias)}` +
    (okClicks !== aHits ? `\n  NOTE ok-clicks(${okClicks}) vs recorded-A(${aHits}) — clicks resolving on the dying/new doc (gray zone)` : ''));

  // ================= T2b: click ∥ same-doc position swap x20 =================
  await s.call('navigate_page', { pageId: pg, url: U + '/p?t2b=1&swap=0' });
  await waitArmed(pg, 't2b=1');
  await s.call('evaluate_script', { pageId: pg, function: `() => { window.name=''; return 1 }` });
  // attach the debugger so click takes the CDP coords path when tab is active
  await s.call('take_snapshot', { pageId: pg, verbose: true });
  let swapErrs = 0, cdpClicks = 0, synClicks = 0, cErr = 0;
  const t2bLog = [];
  for (let i = 0; i < 20; i++) {
    const { uid: uidA } = await freshUidA();
    if (!uidA) { t2bLog.push(`r${i}: NO UID`); continue; }
    const [c, sw] = await Promise.all([
      s.call('click', { pageId: pg, uid: uidA }),
      s.call('evaluate_script', { pageId: pg, function: SWAP }),
    ]);
    const via = (c.sc && c.sc.via) || '-';
    if (via === 'cdp') cdpClicks++; else if (via === 'synthetic') synClicks++;
    if (!c.ok) cErr++;
    if (!sw.ok) swapErrs++;
    t2bLog.push(`r${i}: click=${c.ok ? 'ok/' + via : 'ERR ' + c.text.slice(0, 70)} swap=${sw.ok ? 'ok' : 'ERR ' + sw.text.slice(0, 60)}`);
  }
  const ctr = await s.call('evaluate_script', { pageId: pg, function: COUNTERS });
  const cm = ctr.text.match(/ca=(\d+) cb=(\d+)/);
  const ca = cm ? +cm[1] : -1, cb = cm ? +cm[2] : -1;
  console.log('T2b counters:', ctr.text.slice(0, 120), '| cdp=' + cdpClicks, 'syn=' + synClicks);
  console.log(t2bLog.join('\n'));
  report('T2b click∥DOM-swap x20',
    cb > 0 ? 'FAIL — CDP coord-click hit swapped element' : 'PASS',
    `a-clicks=${ca} b-clicks=${cb} | via cdp=${cdpClicks} synthetic=${synClicks} | clickErr=${cErr} swapErrs=${swapErrs}`);

  // ================= T3: snapshot during rapid DOM mutation =================
  const pg3 = tabs.track(await s.call('new_page', { url: U + '/mut', background: true }));
  await sleep(400); // let mutation spin up
  const snapRes = [];
  for (let i = 0; i < 30; i++) snapRes.push(await s.call('take_snapshot', { pageId: pg3 }));
  const burst = await Promise.all(Array.from({ length: 8 }, () => s.call('take_snapshot', { pageId: pg3 })));
  const genNow = await s.call('evaluate_script', { pageId: pg3, function: `() => { clearInterval(window.__mt); return window.__gen }` });
  const all = [...snapRes, ...burst];
  const errs = all.filter(r => !r.ok);
  let dupUidSnaps = 0, mixedGenSnaps = 0, parsed = 0, iframeSeen = 0;
  for (const r of all) {
    const lines = (r.sc && r.sc.lines) || [];
    if (!lines.length) continue;
    parsed++;
    const uids = lines.map(l => (l.match(/\[([^\]]+)\]/) || [])[1]).filter(Boolean);
    if (new Set(uids).size !== uids.length) dupUidSnaps++;
    if (lines.some(l => /iframe frameId=/.test(l))) iframeSeen++;
    const gens = new Set(lines.map(l => (l.match(/m\d+ gen(\d+)/) || [])[1]).filter(Boolean));
    if (gens.size > 1) mixedGenSnaps++;
  }
  report('T3 snapshot during mutation',
    (errs.length || dupUidSnaps || mixedGenSnaps) ? 'FAIL' : 'PASS',
    `snapshots=${all.length} parsed=${parsed} errs=${errs.length} dupUidSnaps=${dupUidSnaps} mixedGenSnaps(mainFrame)=${mixedGenSnaps} iframeLinesSeen=${iframeSeen} lastGen=${genNow.text.slice(0, 40)}` +
    (errs.length ? '\n  errs: ' + JSON.stringify(errs.map(brief).slice(0, 5)) : ''));

  // ================= T8: same uid clicked by 10 parallel calls =================
  await s.call('navigate_page', { pageId: pg, url: U + '/p?t8=1&swap=0' });
  await waitArmed(pg, 't8=1');
  const { uid: uid8 } = await freshUidA();
  const clicks10 = await Promise.all(Array.from({ length: 10 }, () => s.call('click', { pageId: pg, uid: uid8 })));
  const ok10 = clicks10.filter(c => c.ok);
  const vias10 = {};
  ok10.forEach(c => { const v = (c.sc && c.sc.via) || '-'; vias10[v] = (vias10[v] || 0) + 1; });
  const ctr8 = await s.call('evaluate_script', { pageId: pg, function: COUNTERS });
  const m8 = ctr8.text.match(/ca=(\d+) cb=(\d+)/);
  const a8 = m8 ? +m8[1] : -1, b8 = m8 ? +m8[2] : -1;
  report('T8 same uid x10 parallel clicks',
    (ok10.length !== 10 || a8 !== 10 || b8 !== 0) ? 'CHECK' : 'PASS',
    `ok=${ok10.length}/10 vias=${JSON.stringify(vias10)} | counters a=${a8} b=${b8} (expect 10/0: at-least-once-per-call; no dedup contract exists)` +
    (ok10.length !== 10 ? '\n  fails: ' + JSON.stringify(clicks10.filter(c => !c.ok).map(brief)) : ''));

} catch (e) {
  report('FATAL', 'FAIL', String((e && e.stack) || e));
} finally {
  await tabs.closeAll(s);
  await s.close();
  srv.close();
  console.log('\ncleanup done. health@end:', JSON.stringify(await health()));
  console.log('\n================ SUMMARY ================');
  for (const [n, v] of R) console.log(`${v}  ${n}`);
}
