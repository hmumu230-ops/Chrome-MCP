// adv-09-stress.mjs — load & concurrency stress test for chrome-mcp bridge.
// Covers: session cap (30 ok / 60 over-cap), pending cap (50 / 300 parallel),
// 20 parallel new_page (tracked + closed), 200-call rapid-fire latency,
// heavy take_snapshot, same-tab parallel eval/screenshot, navigate||snapshot.
// Cleanup: closes ONLY tabs we created (by returned pageId) + DELETEs our sessions.

import { setTimeout as delay } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:7890/mcp';
const ROOT = 'http://127.0.0.1:7890/';

const mySessions = new Set();
const myTabs = new Set();
const report = {};
const t0all = performance.now();

const status = async () => {
  try { const r = await fetch(ROOT); return await r.json(); }
  catch (e) { return { error: String(e && e.message || e) }; }
};

async function rawPost(body, sid) {
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const t0 = performance.now();
  try {
    const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    const msgs = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {} }
    }
    if (!msgs.length && text.trim().startsWith('{')) { try { msgs.push(JSON.parse(text)); } catch {} }
    return { status: r.status, sid: r.headers.get('mcp-session-id'), msg: msgs[msgs.length - 1], ms: performance.now() - t0, bytes: text.length };
  } catch (e) {
    return { status: 0, error: String(e && e.message || e), ms: performance.now() - t0, bytes: 0 };
  }
}

async function mk() {
  const init = await rawPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-09-stress', version: '0' } } });
  if (init.status !== 200 || !init.sid) return { ok: false, status: init.status, error: init.error || (init.msg && JSON.stringify(init.msg.error)) || 'no session id', ms: init.ms };
  const sid = init.sid;
  mySessions.add(sid);
  await rawPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  let i = 1;
  const call = async (name, args) => {
    const id = ++i;
    const r = await rawPost({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }, sid);
    const res = r.msg && r.msg.result;
    return {
      ms: r.ms, status: r.status, reqId: id,
      idMatch: r.msg && r.msg.id !== undefined ? r.msg.id === id : null,
      rpcErr: r.msg && r.msg.error ? JSON.stringify(r.msg.error).slice(0, 150) : null,
      isError: !!(res && res.isError),
      errText: res && res.isError ? String(res.content?.[0]?.text || '').slice(0, 140)
             : (r.error || r.rpcErr || (r.status >= 400 ? 'HTTP ' + r.status : null)),
      sc: res && res.structuredContent,
      bytes: r.bytes,
      imgBytes: res && res.content && res.content[0] && res.content[0].type === 'image' ? res.content[0].data.length : 0,
    };
  };
  return { ok: true, sid, call, initMs: init.ms };
}

async function closeSession(sid) {
  try { await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': sid } }); } catch {}
  mySessions.delete(sid);
}

const round = v => v == null ? null : Math.round(v * 100) / 100;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * p / 100) - 1)]; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; };
const lat = rs => ({
  n: rs.length,
  ok: rs.filter(r => r.status === 200 && !r.isError && !r.rpcErr).length,
  toolErr: rs.filter(r => r.isError).length,
  httpErr: rs.filter(r => r.status !== 200).length,
  idMismatch: rs.filter(r => r.idMatch === false).length,
  p50: round(pct(rs.map(r => r.ms), 50)), p95: round(pct(rs.map(r => r.ms), 95)),
  p99: round(pct(rs.map(r => r.ms), 99)), max: round(Math.max(...rs.map(r => r.ms), 0)),
  errSample: [...new Set(rs.filter(r => r.errText).map(r => r.errText))].slice(0, 4),
});

async function cleanup(reason) {
  console.log(`\n[cleanup] ${reason} — closing ${myTabs.size} tabs, deleting ${mySessions.size} sessions`);
  // One utility session for tab cleanup (or reuse an existing one).
  let util;
  try { util = await mk(); } catch {}
  if (util && util.ok) {
    for (const pid of [...myTabs]) {
      try {
        const r = await util.call('close_page', { pageId: pid });
        if (!r.isError && r.sc && r.sc.closed === pid) myTabs.delete(pid);
        else console.log(`[cleanup] close_page ${pid}: ${r.errText || 'no confirm'}`);
      } catch (e) { console.log(`[cleanup] close_page ${pid} threw: ${e.message}`); }
    }
  }
  await Promise.all([...mySessions].map(closeSession));
  report.finalStatus = await status();
  report.totalRuntime_s = round((performance.now() - t0all) / 1000);
  report.leftoverTabs = myTabs.size;
  console.log(JSON.stringify(report, null, 2));
}

const watchdog = setTimeout(() => { cleanup('WATCHDOG at 210s').then(() => process.exit(3)); }, 210000);

try {
  // ---------- Phase A: session cap ----------
  report.baseline = await status();
  const s1 = await Promise.all(Array.from({ length: 30 }, () => mk()));
  report.phaseA_30 = {
    ok: s1.filter(s => s.ok).length, fail: s1.filter(s => !s.ok).length,
    failByStatus: countBy(s1.filter(s => !s.ok), s => s.status),
    p50init: round(pct(s1.map(s => s.initMs || s.ms), 50)),
    sessionsNow: (await status()).sessions,
  };
  const s2 = await Promise.all(Array.from({ length: 60 }, () => mk()));
  report.phaseA_60 = {
    ok: s2.filter(s => s.ok).length, fail: s2.filter(s => !s.ok).length,
    failByStatus: countBy(s2.filter(s => !s.ok), s => s.status),
    sessionsNow: (await status()).sessions,
    capRespected: (await status()).sessions <= 50,
  };
  await Promise.all([...mySessions].map(closeSession));
  report.phaseA_afterCleanup = (await status()).sessions;

  // ---------- Phase B: pending cap on one session ----------
  const ses = await mk();
  if (!ses.ok) throw new Error('cannot create main session: ' + JSON.stringify(ses));
  report.phaseB_session = await status();

  const b50 = await Promise.all(Array.from({ length: 50 }, () => ses.call('list_pages')));
  report.phaseB_50 = { ...lat(b50), saneArrays: b50.filter(r => r.sc && Array.isArray(r.sc.items)).length };

  const b300 = await Promise.all(Array.from({ length: 300 }, () => ses.call('list_pages')));
  report.phaseB_300 = {
    ...lat(b300),
    saneArrays: b300.filter(r => r.sc && Array.isArray(r.sc.items)).length,
    tooManyInFlight: b300.filter(r => r.isError && /too many in-flight/.test(r.errText || '')).length,
    errKinds: countBy(b300.filter(r => r.errText), r => (r.errText || '').split('(')[0].trim().slice(0, 60)),
  };
  report.phaseB_after = await status();

  // ---------- Phase C: 20 parallel new_page ----------
  const cRes = await Promise.all(Array.from({ length: 20 }, () => ses.call('new_page', { url: 'about:blank' })));
  const newIds = cRes.map(r => r.sc && r.sc.pageId).filter(x => typeof x === 'number');
  newIds.forEach(id => myTabs.add(id));
  report.phaseC_new = { ...lat(cRes), pageIdsReturned: newIds.length, uniqueIds: new Set(newIds).size };
  const cClose = await Promise.all(newIds.map(pid => ses.call('close_page', { pageId: pid })));
  let closedOk = 0;
  cClose.forEach((r, k) => { if (!r.isError && r.sc && r.sc.closed === newIds[k]) { closedOk++; myTabs.delete(newIds[k]); } });
  report.phaseC_close = { ...lat(cClose), confirmedClosed: closedOk };
  report.phaseC_after = await status();

  // ---------- Phase D: 200 rapid-fire sequential ----------
  const dRes = [];
  const d0 = performance.now();
  for (let k = 0; k < 200; k++) dRes.push(await ses.call('list_pages'));
  report.phaseD_seq200 = { ...lat(dRes), wallMs: round(performance.now() - d0), callsPerSec: round(200000 / (performance.now() - d0)) };

  // ---------- Phase E: heavy snapshot ----------
  const hn = await ses.call('new_page', { url: 'https://news.ycombinator.com' });
  const hnId = hn.sc && hn.sc.pageId;
  if (typeof hnId === 'number') myTabs.add(hnId);
  await delay(4000); // let it load (new_page doesn't wait)
  const snap = await ses.call('take_snapshot', { pageId: hnId });
  report.phaseE_snapshot = {
    ms: round(snap.ms), status: snap.status, isError: snap.isError,
    respBytes: snap.bytes, mode: snap.sc && snap.sc.mode,
    lines: snap.sc && snap.sc.lines ? snap.sc.lines.length : null,
    errText: snap.errText,
  };

  // ---------- Phase F: same-tab parallelism ----------
  const evals = await Promise.all(Array.from({ length: 10 }, (_, k) =>
    ses.call('evaluate_script', { pageId: hnId, function: `() => { (window.__adv09 = window.__adv09 || []).push(${k}); return 'adv09-marker-${k}'; }` })));
  const markerOk = evals.filter((r, k) => r.sc && r.sc.result === `adv09-marker-${k}`).length;
  const order = await ses.call('evaluate_script', { pageId: hnId, function: '() => (window.__adv09 || []).join(",")' });
  report.phaseF_eval10 = { ...lat(evals), markerMatch: markerOk, pushOrder: order.sc && order.sc.result };

  const shots = await Promise.all(Array.from({ length: 10 }, () =>
    ses.call('take_screenshot', { pageId: hnId, format: 'jpeg', quality: 40 })));
  report.phaseF_shot10 = { ...lat(shots), imgBytes: countBy(shots, r => r.imgBytes > 0 ? '~' + Math.round(r.imgBytes / 1024) + 'k' : 'none') };

  // ---------- Phase G: navigate || snapshot same tab ----------
  const [nav, snap2] = await Promise.all([
    ses.call('navigate_page', { pageId: hnId, type: 'url', url: 'https://example.com' }),
    ses.call('take_snapshot', { pageId: hnId }),
  ]);
  report.phaseG = {
    nav: { ms: round(nav.ms), isError: nav.isError, url: nav.sc && nav.sc.url, errText: nav.errText },
    snap: { ms: round(snap2.ms), isError: snap2.isError, url: snap2.sc && snap2.sc.url, lines: snap2.sc && snap2.sc.lines ? snap2.sc.lines.length : null, errText: snap2.errText },
  };

  report.phaseH_preCleanup = await status();
} catch (e) {
  report.fatal = String(e && e.stack || e);
}

clearTimeout(watchdog);
await cleanup('normal');
process.exit(0);
