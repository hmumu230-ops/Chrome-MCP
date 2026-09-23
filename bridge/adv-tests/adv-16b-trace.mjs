// adv-16b-trace.mjs — part 2: tests that didn't complete in run 1 (bridge died mid-run).
// T5 detach during ACTIVE trace | T6 nav/reload mid-trace | T7 filePath | T8 analyze_insight
// T9 same-tab attach lock | T10 5-tab parallel attach | T11 concurrent stops
// T12 close mid-trace | T13 stop-after-stop | T1R stop-without-start retest
// + T3b: cross-tab trace global-lock state leak.
import fs from 'node:fs';

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
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => {
  if (!r) return '<no response>';
  if (r.timeout) return '<CLIENT TIMEOUT ' + r.ms + 'ms>';
  const s = txt(r) || JSON.stringify(r.msg && r.msg.error || r.msg);
  return (isErr(r) ? 'ERR ' : 'ok  ') + s.replace(/\s+/g, ' ').slice(0, 200);
};
const timed = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true, ms }))]);
const R = [];
const report = (n, s) => { R.push([n, s]); console.log(`\n### ${n}\n${s}`); };
const ec = r => (sc(r) || {}).eventCount;

const tabs = { mine: [] };
const newTab = async url => { const r = await call('new_page', { url, background: true }); const p = sc(r) && sc(r).pageId; if (p) tabs.mine.push(p); return { r, p }; };
const OUTDIR = 'D:\\Tool\\chrome-mcp\\bridge\\test-out';

try {
  const health0 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('health:', JSON.stringify(health0));

  // ---------- T1R: stop_trace without start (retest, now bridge is stable) ----------
  const { p: C } = await newTab('https://example.com');
  await sleep(1500);
  let t0 = Date.now();
  const stopNoStart = await timed(call('performance_stop_trace', { pageId: C }), 20000);
  console.log('T1R stop-without-start (' + (Date.now() - t0) + 'ms):', brief(stopNoStart));
  const detC = await timed(call('detach_debugger', { pageId: C }), 10000);
  console.log('T1R detach after:', brief(detC));
  report('T1R stop without start', `stop(${Date.now() - t0}ms)=${brief(stopNoStart)} | post-detach=${brief(detC)}`);

  // ---------- T3b: cross-tab trace lock + state leak after failed start ----------
  const { p: A } = await newTab('https://example.com');
  const { p: B } = await newTab('https://en.wikipedia.org/wiki/Main_Page');
  await sleep(2500);
  const a1 = await timed(call('performance_start_trace', { pageId: A }), 15000);
  const b1 = await timed(call('performance_start_trace', { pageId: B }), 15000); // expect fail (global lock)
  const b1b = await timed(call('performance_start_trace', { pageId: B }), 15000); // again — state leak?
  const bstop = await timed(call('performance_stop_trace', { pageId: B }), 20000); // what does stop do now?
  const a2 = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  // after A stopped, does B recover (s.tracing still stale) or stay wedged?
  const b2 = await timed(call('performance_start_trace', { pageId: B }), 15000);
  const bstop2 = b2 && !isErr(b2) ? await timed(call('performance_stop_trace', { pageId: B }), 30000) : null;
  console.log('T3b A.start=', brief(a1));
  console.log('T3b B.start(locked)=', brief(b1));
  console.log('T3b B.start again=', brief(b1b));
  console.log('T3b B.stop after failed start=', brief(bstop));
  console.log('T3b A.stop=', brief(a2), 'events=', ec(a2));
  console.log('T3b B.start after A stopped=', brief(b2));
  if (bstop2) console.log('T3b B.stop2=', brief(bstop2), 'events=', ec(bstop2));
  report('T3b cross-tab trace lock + state leak', `B.start-while-A-active=${brief(b1)} | B.start-again=${brief(b1b)} | B.stop=${brief(bstop)} | after A stopped: B.start=${brief(b2)} B.stop=${bstop2 ? brief(bstop2) : 'n/a'}`);

  // ---------- T5: detach_debugger during ACTIVE trace (no stop in flight) ----------
  const st5 = await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(800);
  const det2 = await timed(call('detach_debugger', { pageId: A }), 10000);
  console.log('T5 start:', brief(st5), '| detach-during-active-trace:', brief(det2));
  const probe1 = await timed(call('performance_stop_trace', { pageId: A }), 10000);
  const probe2 = await timed(call('detach_debugger', { pageId: A }), 10000);
  const probe3 = await timed(call('list_console_messages', { pageId: A }), 15000);
  console.log('T5 probes: stop=', brief(probe1), '| detach#2=', brief(probe2), '| reattach=', brief(probe3));
  const rec1 = await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(600);
  const rec2 = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T5 recovery: start=', brief(rec1), '| stop=', brief(rec2), 'events=', ec(rec2));
  report('T5 detach during ACTIVE trace', `detach=${brief(det2)} | then: stop=${brief(probe1)} detach2=${brief(probe2)} reattach=${brief(probe3)} | recovery start=${brief(rec1)} stop events=${ec(rec2)} err=${isErr(rec2)}`);

  // ---------- T6: trace across navigation/reload ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(400);
  const nav = await timed(call('navigate_page', { pageId: A, url: 'https://example.org' }), 20000);
  await sleep(1500);
  const stopNav = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T6 nav=', brief(nav), '| stop-after-nav:', brief(stopNav), 'events=', ec(stopNav));
  const rs = await timed(call('performance_start_trace', { pageId: A, reload: true }), 15000);
  await sleep(2500);
  const rst = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T6 reload-start=', brief(rs), '| stop=', brief(rst), 'events=', ec(rst));
  report('T6 trace across navigation', `nav-mid-trace=${brief(nav)} stop events=${ec(stopNav)} err=${isErr(stopNav)} | reload:true start=${brief(rs)} stop events=${ec(rst)} err=${isErr(rst)}`);

  // ---------- T7: filePath output ----------
  const traceFile = OUTDIR + '\\adv16-trace.json';
  try { fs.unlinkSync(traceFile); } catch {}
  await timed(call('performance_start_trace', { pageId: B }), 10000);
  await sleep(3000);
  t0 = Date.now();
  const stopFile = await timed(call('performance_stop_trace', { pageId: B, filePath: traceFile }), 40000);
  let fileInfo = 'missing';
  try {
    const stat = fs.statSync(traceFile);
    const raw = fs.readFileSync(traceFile, 'utf8');
    const parsed = JSON.parse(raw);
    const evts = parsed.traceEvents;
    const names2 = new Set((evts || []).map(e => e.name));
    fileInfo = `size=${stat.size}B events=${Array.isArray(evts) ? evts.length : 'N/A'} sampleNames=${[...names2].slice(0, 10).join(',')}`;
  } catch (e) { fileInfo = 'parse/stat failed: ' + e.message; }
  console.log(`T7 stop+file (${Date.now() - t0}ms):`, brief(stopFile), '| file:', fileInfo);
  report('T7 trace filePath output', `stop=${brief(stopFile)} | ${fileInfo}`);

  // ---------- T8: performance_analyze_insight ----------
  const ai = await timed(call('performance_analyze_insight', { pageId: B, insightSetId: 'x', insightName: 'LCPPhases' }), 10000);
  console.log('T8 analyze_insight:', brief(ai), '| http status:', ai.status);
  report('T8 performance_analyze_insight', `status=${ai.status} ${brief(ai)}`);

  // ---------- T9: parallel first-attach SAME tab ----------
  const { p: D } = await newTab('https://example.com');
  await sleep(1200);
  const [at1, at2, at3] = await Promise.all([
    timed(call('list_console_messages', { pageId: D }), 15000),
    timed(call('list_network_requests', { pageId: D }), 15000),
    timed(call('list_console_messages', { pageId: D }), 15000),
  ]);
  const attachErrs = [at1, at2, at3].filter(r => isErr(r) || r.timeout);
  console.log('T9 parallel attach same tab:', [at1, at2, at3].map(brief).join(' || '));
  report('T9 parallel implicit attach same tab', `errors=${attachErrs.length}/3 ${attachErrs.map(brief).join('|') || '(none — attach lock works)'}`);

  // ---------- T10: attach on 5 tabs in parallel ----------
  const five = [];
  for (let k = 0; k < 5; k++) { const { p } = await newTab('https://example.com'); five.push(p); }
  await sleep(2500);
  const tens = await Promise.all(five.map(p => timed(call('list_console_messages', { pageId: p }), 20000)));
  const tenErrs = tens.filter(r => isErr(r) || r.timeout);
  console.log('T10 5-tab parallel attach:', tens.map(brief).join(' || '));
  report('T10 parallel attach on 5 tabs', `errors=${tenErrs.length}/5 ${tenErrs.map(brief).join('|') || '(none)'}`);

  // ---------- T11: two concurrent stop_trace on same trace ----------
  const stA = await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(800);
  const t11 = Date.now();
  const [st_a, st_b] = await Promise.all([
    timed(call('performance_stop_trace', { pageId: A }), 75000),
    timed(call('performance_stop_trace', { pageId: A }), 75000),
  ]);
  const el11 = Date.now() - t11;
  console.log(`T11 start=`, brief(stA), `| concurrent stops (${el11}ms): A=`, brief(st_a), '| B=', brief(st_b));
  report('T11 concurrent stop_trace same trace', `(${el11}ms) stopA=${brief(st_a)} | stopB=${brief(st_b)} | hang=${st_a.timeout || st_b.timeout || el11 > 55000}`);

  // ---------- T12: close tab mid-trace ----------
  const { p: E } = await newTab('https://example.com');
  await sleep(1200);
  const stE = await timed(call('performance_start_trace', { pageId: E }), 10000);
  await sleep(500);
  const closeE = await timed(call('close_page', { pageId: E }), 10000);
  await sleep(500);
  const stopDead = await timed(call('performance_stop_trace', { pageId: E }), 15000);
  const sanityOther = await timed(call('list_console_messages', { pageId: A }), 15000);
  console.log('T12 start=', brief(stE), '| close-mid-trace:', brief(closeE), '| stop-on-dead-tab:', brief(stopDead), '| sanity:', brief(sanityOther));
  report('T12 close tab mid-trace', `close=${brief(closeE)} | stopDead=${brief(stopDead)} | otherTabOK=${!isErr(sanityOther)}`);

  // ---------- T13: stop after successful stop ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(500);
  const g1 = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  const g2 = await timed(call('performance_stop_trace', { pageId: A }), 15000);
  console.log('T13 good-stop:', brief(g1), '| second-stop:', brief(g2));
  report('T13 stop after stop', `first=${brief(g1)} | second=${brief(g2)}`);

  // ---------- T14: in-flight stop vs PAGE CLOSE (stronger detach path) ----------
  const { p: F } = await newTab('https://example.com');
  await sleep(1200);
  await timed(call('performance_start_trace', { pageId: F }), 10000);
  await sleep(600);
  t0 = Date.now();
  const stopF = timed(call('performance_stop_trace', { pageId: F }), 70000);
  await sleep(300);
  const closeF = await timed(call('close_page', { pageId: F }), 10000);
  const stopFRes = await stopF;
  console.log(`T14 in-flight stop vs close (${Date.now() - t0}ms):`, brief(stopFRes), '| close:', brief(closeF));
  report('T14 close page while stop in-flight', `stop(${Date.now() - t0}ms)=${brief(stopFRes)} | close=${brief(closeF)}`);

  const health1 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('final health:', JSON.stringify(health1));
} finally {
  for (const id of tabs.mine) {
    try { await timed(call('performance_stop_trace', { pageId: id }), 8000); } catch {}
    try { await timed(call('detach_debugger', { pageId: id }), 8000); } catch {}
    const r = await timed(call('close_page', { pageId: id }), 8000);
    console.log('cleanup close', id, brief(r));
  }
}

console.log('\n================ SUMMARY ================');
for (const [n, s] of R) console.log(`* ${n}: ${s}`);
