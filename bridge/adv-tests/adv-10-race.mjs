// adv-10-race.mjs — TOCTOU / race-condition tests against chrome-mcp bridge.
// Dispatch in the extension SW is fully concurrent (ws.js: no mutex), so these
// races are real. Run: node adv-10-race.mjs

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(b),
  });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });

// ---- helpers ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => {
  if (!r) return '<no response>';
  if (r.timeout) return '<CLIENT TIMEOUT ' + r.ms + 'ms>';
  const s = txt(r) || JSON.stringify(r.msg && r.msg.error || r.msg);
  return (isErr(r) ? 'ERR ' : 'ok  ') + s.replace(/\s+/g, ' ').slice(0, 220);
};
// bound a call: resolves {timeout:true} instead of hanging the suite
const timed = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true, ms }))]);
const R = [];
const report = (n, s) => { R.push([n, s]); console.log(`\n### ${n}\n${s}`); };
const uidOf = (snap, re) => {
  const line = ((sc(snap) || {}).lines || []).find(l => re.test(l));
  const m = line && line.match(/^\s*\[([^\]]+)\]/);
  return m && m[1];
};

const tabs = { mine: [] };
const newTab = async url => { const r = await call('new_page', { url }); const p = sc(r) && sc(r).pageId; if (p) tabs.mine.push(p); return { r, p }; };

try {
  // ---------- setup ----------
  const health0 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('health:', JSON.stringify(health0));
  const { p: P } = await newTab('https://example.com');
  const { p: Q } = await newTab('https://example.org');
  console.log('P=' + P, 'Q=' + Q);
  await call('select_page', { pageId: P });
  await sleep(600);

  // ================= R1: snapshot -> navigate -> click OLD uid =================
  // instrument example.com link so a stray click is observable but harmless
  await call('evaluate_script', { pageId: P, function: `() => { window.__c1=0; document.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();window.__c1++})); return 'armed1' }` });
  const snap1 = await call('take_snapshot', { pageId: P });
  const uid1 = uidOf(snap1, /link /);
  console.log('R1 uid on example.com:', uid1, '| snap err?', isErr(snap1));
  const nav1 = call('navigate_page', { pageId: P, url: 'https://example.org' });
  // fire a click WHILE navigation is in flight (old doc dying)
  const clickDuring = await timed(call('click', { pageId: P, uid: uid1 }), 15000);
  await nav1;
  console.log('R1a click-during-nav:', brief(clickDuring));
  // after commit: frameMap cleared -> click old uid with NO fresh snapshot
  const clickStaleNoSnap = await timed(call('click', { pageId: P, uid: uid1 }), 15000);
  console.log('R1b click-stale-no-snapshot:', brief(clickStaleNoSnap));
  // arm example.org's link, take a NEW snapshot (uid counter resets -> collision)
  await call('evaluate_script', { pageId: P, function: `() => { window.__c2=0; document.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();window.__c2++})); return 'armed2' }` });
  const snap2 = await call('take_snapshot', { pageId: P });
  const uid2 = uidOf(snap2, /link /);
  console.log('R1 fresh uid on example.org:', uid2);
  const clickStaleSnap = await timed(call('click', { pageId: P, uid: uid1 }), 15000);
  const c2 = await call('evaluate_script', { pageId: P, function: `() => window.__c2` });
  console.log('R1c click-stale-after-new-snapshot:', brief(clickStaleSnap), '| example.org link clicks (should be 0):', txt(c2));
  report('R1 stale uid after navigate', `during-nav: ${brief(clickDuring)} | no-new-snap: ${brief(clickStaleNoSnap)} | after-new-snap: ${brief(clickStaleSnap)} | wrong-el hits=${txt(c2)}`);

  // ================= R2: close_page WHILE take_screenshot in flight =================
  const { p: S } = await newTab('https://example.com');
  await sleep(1500);
  const t0 = Date.now();
  const shot = timed(call('take_screenshot', { pageId: S, fullPage: true }), 40000);
  await sleep(300); // let it get in-flight
  const closeS = await call('close_page', { pageId: S });
  const shotRes = await shot;
  console.log('R2 close:', brief(closeS), `| screenshot after ${Date.now() - t0}ms:`, brief(shotRes));
  report('R2 close_page vs in-flight screenshot', `close=${brief(closeS)} | shot(${Date.now() - t0}ms)=${brief(shotRes)}`);

  // ================= R3: reload WHILE list_network_requests =================
  await call('list_network_requests', { pageId: P }); // attach + Network.enable
  const nav3 = call('navigate_page', { pageId: P, type: 'reload' });
  const during = [];
  for (let k = 0; k < 4; k++) { during.push(await timed(call('list_network_requests', { pageId: P }), 10000)); await sleep(120); }
  await nav3;
  await sleep(800);
  const after = await call('list_network_requests', { pageId: P });
  const tot = r => (sc(r) || {}).total;
  console.log('R3 totals during reload:', during.map(tot).join(','), '-> after:', tot(after));
  report('R3 reload vs network collector', `during totals=${during.map(tot).join(',')} errs=${during.filter(isErr).length} | after total=${tot(after)} err=${isErr(after)}`);

  // ================= R4: detach_debugger WHILE trace active =================
  const t4a = await call('performance_start_trace', { pageId: P });
  await sleep(700);
  const det1 = await call('detach_debugger', { pageId: P });
  const stopAfterDetach = await timed(call('performance_stop_trace', { pageId: P }), 20000);
  console.log('R4a start:', brief(t4a), '| detach:', brief(det1), '| stop-after-detach:', brief(stopAfterDetach));
  // R4b: stop_trace IN-FLIGHT when detach lands — does the pending promise hang?
  await call('performance_start_trace', { pageId: P });
  await sleep(700);
  const t4 = Date.now();
  const stopP = timed(call('performance_stop_trace', { pageId: P }), 25000);
  await sleep(300);
  const det2 = await call('detach_debugger', { pageId: P });
  const stopRes = await stopP;
  console.log('R4b detach:', brief(det2), `| in-flight stop after ${Date.now() - t4}ms:`, brief(stopRes));
  // re-attach sanity
  const reatt = await call('list_console_messages', { pageId: P });
  console.log('R4c re-attach via list_console_messages:', brief(reatt));
  report('R4 detach vs trace', `start=${brief(t4a)} detach=${brief(det1)} stopAfterDetach=${brief(stopAfterDetach)} | in-flight stop=${stopRes.timeout ? 'HANG>25s' : brief(stopRes)} | reattach=${brief(reatt)}`);

  // ================= R5: dialog race — alert() + 2x handle_dialog =================
  await call('select_page', { pageId: P });
  const pre = await call('handle_dialog', { pageId: P, action: 'accept' }); // attaches debugger; expect 'no open dialog'
  console.log('R5 pre-handle (expect no-dialog err):', brief(pre));
  const evalAlert = timed(call('evaluate_script', { pageId: P, function: `() => { alert('race-dlg'); return 'alerted' }` }), 30000);
  await sleep(1200);
  const dbl = await Promise.all([
    timed(call('handle_dialog', { pageId: P, action: 'accept' }), 10000),
    timed(call('handle_dialog', { pageId: P, action: 'dismiss' }), 10000),
  ]);
  const evalRes = await evalAlert;
  console.log('R5 handle x2:', dbl.map(brief).join(' || '), '| eval:', brief(evalRes));
  // mop-up if a dialog is still queued
  if (evalRes.timeout || isErr(evalRes)) { const mop = await timed(call('handle_dialog', { pageId: P, action: 'dismiss' }), 8000); console.log('R5 mop-up:', brief(mop)); }
  report('R5 dialog double-handle', `pre=${brief(pre)} | h1=${brief(dbl[0])} | h2=${brief(dbl[1])} | eval=${brief(evalRes)}`);

  // ================= R6: parallel select_page on 2 tabs =================
  const sel = await Promise.all([
    timed(call('select_page', { pageId: P }), 10000),
    timed(call('select_page', { pageId: Q }), 10000),
  ]);
  await sleep(400);
  const lp = await call('list_pages', {});
  const mine = ((sc(lp) || {}).items || []).filter(t => tabs.mine.includes(t.pageId));
  console.log('R6 select results:', sel.map(brief).join(' || '), '| my tabs:', JSON.stringify(mine.map(t => ({ id: t.pageId, active: t.active, win: t.windowId }))));
  report('R6 parallel select_page', `both-ok=${sel.every(r => !isErr(r) && !r.timeout)} | actives among mine=${mine.filter(t => t.active).length} (same-window=${mine.length > 1 && mine[0].windowId === mine[1].windowId})`);

  // ================= R7: 5 parallel clicks on the SAME uid =================
  await call('detach_debugger', { pageId: P }); // force deterministic synthetic path
  await call('select_page', { pageId: P });
  await call('evaluate_script', { pageId: P, function: `() => { const b=document.createElement('button'); b.id='rc'; b.textContent='race-btn'; b.onclick=()=>{window.__rc=(window.__rc||0)+1}; document.body.appendChild(b); return 'added' }` });
  const snap7 = await call('take_snapshot', { pageId: P });
  const uid7 = uidOf(snap7, /race-btn/);
  console.log('R7 button uid:', uid7);
  const clicks = await Promise.all(Array.from({ length: 5 }, () => timed(call('click', { pageId: P, uid: uid7 }), 15000)));
  await sleep(300);
  const rc = await call('evaluate_script', { pageId: P, function: `() => window.__rc` });
  console.log('R7 clicks:', clicks.map(brief).join(' || '), '| actual DOM clicks:', txt(rc));
  report('R7 5x parallel click same uid', `ok=${clicks.filter(r => !isErr(r) && !r.timeout).length}/5 err=${clicks.filter(isErr).length} | domClickCount=${txt(rc)} (expect 5; >5=double-handled, <5=lost)`);

  // ================= R8: fill + click + navigate without awaits =================
  await call('evaluate_script', { pageId: P, function: `() => { const i=document.createElement('input'); i.id='ri'; document.body.appendChild(i); return 'added' }` });
  const snap8 = await call('take_snapshot', { pageId: P });
  const uidI = uidOf(snap8, /textbox/);
  const uidB = uidOf(snap8, /race-btn/);
  console.log('R8 uids input=', uidI, 'btn=', uidB);
  const seq = await Promise.all([
    timed(call('fill', { pageId: P, uid: uidI, value: 'x' }), 15000),
    timed(call('click', { pageId: P, uid: uidB }), 15000),
    timed(call('navigate_page', { pageId: P, url: 'https://example.com' }), 20000),
  ]);
  console.log('R8 fill:', brief(seq[0]), '| click:', brief(seq[1]), '| nav:', brief(seq[2]));
  const lp8 = await call('list_pages', {});
  const p8 = ((sc(lp8) || {}).items || []).find(t => t.pageId === P);
  report('R8 fill+click+nav concurrent', `fill=${brief(seq[0])} | click=${brief(seq[1])} | nav=${brief(seq[2])} | finalUrl=${p8 && p8.url}`);

  // ================= R9: close_page then immediate list_network_requests =================
  const { p: T } = await newTab('https://example.com');
  await sleep(1200);
  await call('list_network_requests', { pageId: T }); // attach session
  await call('close_page', { pageId: T });
  const netDead = await timed(call('list_network_requests', { pageId: T }), 10000);
  console.log('R9 net on closed tab:', brief(netDead));
  report('R9 list_network_requests on closed page', brief(netDead));

  // ================= R10: new_page + immediate take_snapshot while loading =================
  const { p: N } = await newTab('https://example.com'); // returns before load completes
  const snapLoad = await timed(call('take_snapshot', { pageId: N }), 15000);
  console.log('R10 snapshot-on-loading:', brief(snapLoad));
  report('R10 snapshot during initial load', brief(snapLoad));

  // ================= R11: evaluate_script on chrome://extensions =================
  const lpAll = await call('list_pages', {});
  let C = ((sc(lpAll) || {}).items || []).find(t => (t.url || '').startsWith('chrome://extensions'));
  if (!C) { const nc = await newTab('chrome://extensions/'); C = { pageId: nc.p }; }
  if (C && C.pageId !== undefined) {
    const evChrome = await timed(call('evaluate_script', { pageId: C.pageId, function: `() => document.title` }), 10000);
    console.log('R11 eval on chrome://extensions:', brief(evChrome));
    report('R11 eval on chrome:// page', brief(evChrome));
  } else report('R11 eval on chrome:// page', 'skipped — could not open chrome://extensions tab');

  // ================= R12: post-race health + zombie debugger check =================
  const health1 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('R12 health:', JSON.stringify(health1));
  const dets = [];
  for (const id of tabs.mine) dets.push([id, brief(await timed(call('detach_debugger', { pageId: id }), 8000))]);
  // fresh sanity: bridge + extension still functional after all races
  const sanity = await timed(call('take_snapshot', { pageId: P }), 15000);
  console.log('R12 detaches:', JSON.stringify(dets), '| sanity snapshot:', brief(sanity));
  report('R12 health/zombies', `health=${JSON.stringify(health1)} | detaches=${JSON.stringify(dets)} | sanity=${brief(sanity)}`);

} finally {
  // cleanup: close tabs I opened
  for (const id of tabs.mine) { const r = await timed(call('close_page', { pageId: id }), 8000); console.log('cleanup close', id, brief(r)); }
}

console.log('\n================ SUMMARY ================');
for (const [n, s] of R) console.log(`* ${n}: ${s}`);
