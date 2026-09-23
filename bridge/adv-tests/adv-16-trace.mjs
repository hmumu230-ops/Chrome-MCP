// adv-16-trace.mjs — tracing + debugger lifecycle races (adversarial tester #16).
// Covers: detach vs active/in-flight traces, concurrent traces/stops, per-tab
// attach lock, trace across navigation, filePath output validity.
// Run: node adv-16-trace.mjs

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
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16', version: '0' } } });
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

const tabs = { mine: [] };
const newTab = async url => { const r = await call('new_page', { url, background: true }); const p = sc(r) && sc(r).pageId; if (p) tabs.mine.push(p); return { r, p }; };
const OUTDIR = 'D:\\Tool\\chrome-mcp\\bridge\\test-out';

try {
  const health0 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('health:', JSON.stringify(health0));

  // ---------- T0: tool inventory ----------
  const listRes = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/list', params: {} });
  const names = ((listRes.msg.result || {}).tools || []).map(t => t.name);
  console.log('tools(' + names.length + '):', names.join(','));
  report('T0 tool inventory', `has performance_analyze_insight=${names.includes('performance_analyze_insight')} | has attach_debugger=${names.includes('attach_debugger')} | has detach_debugger=${names.includes('detach_debugger')} | trace tools=${names.includes('performance_start_trace') && names.includes('performance_stop_trace')}`);

  // ---------- T1: stop_trace without start ----------
  const { p: C } = await newTab('https://example.com');
  await sleep(1200);
  const t1 = Date.now();
  const stopNoStart = await timed(call('performance_stop_trace', { pageId: C }), 15000);
  console.log('T1 stop-without-start (' + (Date.now() - t1) + 'ms):', brief(stopNoStart));
  // side-effect check: did the failed call leave a debugger attached?
  const detC = await call('detach_debugger', { pageId: C });
  console.log('T1 detach after failed stop:', brief(detC));
  report('T1 stop without start', `stop=${brief(stopNoStart)} | post-detach=${brief(detC)} (detached:true => debugger was left attached by the failed call)`);

  // ---------- T2: concurrent start_trace on same tab ----------
  const { p: A } = await newTab('https://example.com');
  await sleep(1500);
  const s1 = await call('performance_start_trace', { pageId: A });
  const s2 = await timed(call('performance_start_trace', { pageId: A }), 10000); // sequential second
  // truly parallel pair on a fresh trace: stop first, then race two starts
  const st1 = await timed(call('performance_stop_trace', { pageId: A }), 20000);
  const [p1, p2] = await Promise.all([
    timed(call('performance_start_trace', { pageId: A }), 10000),
    timed(call('performance_start_trace', { pageId: A }), 10000),
  ]);
  report('T2 concurrent start same tab', `start1=${brief(s1)} | seq-start2=${brief(s2)} | stop=${brief(st1)} | parallel=[${brief(p1)}] + [${brief(p2)}]`);
  // leave the winner running for T4? no — stop it cleanly, fresh traces per test
  const st2 = await timed(call('performance_stop_trace', { pageId: A }), 20000);
  console.log('T2 cleanup stop:', brief(st2));

  // ---------- T3: traces on two tabs simultaneously ----------
  const { p: B } = await newTab('https://en.wikipedia.org/wiki/Main_Page');
  await sleep(2500);
  const [a1, b1] = await Promise.all([
    timed(call('performance_start_trace', { pageId: A }), 15000),
    timed(call('performance_start_trace', { pageId: B }), 15000),
  ]);
  await sleep(2500);
  const [a2, b2] = await Promise.all([
    timed(call('performance_stop_trace', { pageId: A }), 30000),
    timed(call('performance_stop_trace', { pageId: B }), 30000),
  ]);
  const ec = r => (sc(r) || {}).eventCount;
  console.log('T3 A events:', ec(a2), '| B events:', ec(b2));
  report('T3 two tabs simultaneous traces', `startA=${brief(a1)} startB=${brief(b1)} | stopA events=${ec(a2)} err=${isErr(a2)} | stopB events=${ec(b2)} err=${isErr(b2)}`);

  // ---------- T4 REGRESSION: detach_debugger while stop_trace in-flight ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(800);
  const t4 = Date.now();
  const stopInFlight = timed(call('performance_stop_trace', { pageId: A }), 70000);
  await sleep(400); // let Tracing.end get in flight
  const det1 = await timed(call('detach_debugger', { pageId: A }), 10000);
  const stopRes = await stopInFlight;
  const el = Date.now() - t4;
  console.log(`T4 in-flight stop (${el}ms):`, brief(stopRes), '| detach:', brief(det1));
  report('T4 REGRESSION detach during in-flight stop', `stop(${el}ms)=${brief(stopRes)} | detach=${brief(det1)} | hang=${stopRes.timeout || el > 30000}`);

  // ---------- T5: detach_debugger during ACTIVE trace (no stop in flight) ----------
  const st5 = await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(800);
  const det2 = await timed(call('detach_debugger', { pageId: A }), 10000);
  console.log('T5 start:', brief(st5), '| detach-during-active-trace:', brief(det2));
  // state probes after the detach attempt
  const probe1 = await timed(call('performance_stop_trace', { pageId: A }), 10000);
  const probe2 = await timed(call('detach_debugger', { pageId: A }), 10000);
  const probe3 = await timed(call('list_console_messages', { pageId: A }), 15000); // reattach path
  console.log('T5 probes: stop=', brief(probe1), '| detach#2=', brief(probe2), '| reattach=', brief(probe3));
  // recovery: fresh start+stop must work
  const rec1 = await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(500);
  const rec2 = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T5 recovery: start=', brief(rec1), '| stop=', brief(rec2), 'events=', ec(rec2));
  report('T5 detach during ACTIVE trace', `detach=${brief(det2)} | after: stop=${brief(probe1)} detach2=${brief(probe2)} reattach=${brief(probe3)} | recovery events=${ec(rec2)} err=${isErr(rec2)}`);

  // ---------- T6: trace across navigation/reload ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(400);
  const nav = await timed(call('navigate_page', { pageId: A, url: 'https://example.org' }), 20000);
  await sleep(1500);
  const stopNav = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T6 nav=', brief(nav), '| stop-after-nav:', brief(stopNav), 'events=', ec(stopNav));
  // reload:true variant
  const rs = await timed(call('performance_start_trace', { pageId: A, reload: true }), 15000);
  await sleep(2500);
  const rst = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  console.log('T6 reload-start=', brief(rs), '| stop=', brief(rst), 'events=', ec(rst));
  report('T6 trace across navigation', `nav-mid-trace=${brief(nav)} stop events=${ec(stopNav)} err=${isErr(stopNav)} | reload:true start=${brief(rs)} stop events=${ec(rst)} err=${isErr(rst)}`);

  // ---------- T7: filePath output — file exists, parses, real trace ----------
  const traceFile = OUTDIR + '\\adv16-trace.json';
  try { fs.unlinkSync(traceFile); } catch {}
  await timed(call('performance_start_trace', { pageId: B }), 10000); // wikipedia tab
  await sleep(3000);
  const t7 = Date.now();
  const stopFile = await timed(call('performance_stop_trace', { pageId: B, filePath: traceFile }), 40000);
  let fileInfo = 'missing';
  try {
    const stat = fs.statSync(traceFile);
    const raw = fs.readFileSync(traceFile, 'utf8');
    const parsed = JSON.parse(raw);
    const evts = parsed.traceEvents;
    const names2 = new Set((evts || []).map(e => e.name));
    fileInfo = `size=${stat.size}B events=${Array.isArray(evts) ? evts.length : 'N/A'} sampleNames=${[...names2].slice(0, 8).join(',')}`;
  } catch (e) { fileInfo = 'parse/stat failed: ' + e.message; }
  console.log(`T7 stop+file (${Date.now() - t7}ms):`, brief(stopFile), '| file:', fileInfo);
  report('T7 trace filePath output', `stop=${brief(stopFile)} | ${fileInfo}`);

  // ---------- T8: performance_analyze_insight (does it exist?) ----------
  const ai = await timed(call('performance_analyze_insight', { pageId: B, insightSetId: 'x', insightName: 'LCPPhases' }), 10000);
  console.log('T8 analyze_insight:', brief(ai));
  report('T8 performance_analyze_insight', brief(ai));

  // ---------- T9 REGRESSION: parallel first-attach on SAME tab (attach lock) ----------
  const { p: D } = await newTab('https://example.com');
  await sleep(1200);
  const [at1, at2, at3] = await Promise.all([
    timed(call('list_console_messages', { pageId: D }), 15000),
    timed(call('list_network_requests', { pageId: D }), 15000),
    timed(call('list_console_messages', { pageId: D }), 15000),
  ]);
  const attachErrs = [at1, at2, at3].filter(r => isErr(r) || r.timeout);
  console.log('T9 parallel attach same tab:', [at1, at2, at3].map(brief).join(' || '));
  report('T9 parallel implicit attach same tab', `errors=${attachErrs.length}/3 ${attachErrs.map(brief).join('|') || '(none — lock works)'}`);

  // ---------- T10: attach on 5 tabs in parallel ----------
  const five = [];
  for (let k = 0; k < 5; k++) { const { p } = await newTab('https://example.com'); five.push(p); }
  await sleep(2500);
  const tens = await Promise.all(five.map(p => timed(call('list_console_messages', { pageId: p }), 20000)));
  const tenErrs = tens.filter(r => isErr(r) || r.timeout);
  console.log('T10 5-tab parallel attach:', tens.map(brief).join(' || '));
  report('T10 parallel attach on 5 tabs', `errors=${tenErrs.length}/5 ${tenErrs.map(brief).join('|') || '(none)'}`);

  // ---------- T11: two concurrent stop_trace on the same trace ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(800);
  const t11 = Date.now();
  const [st_a, st_b] = await Promise.all([
    timed(call('performance_stop_trace', { pageId: A }), 75000),
    timed(call('performance_stop_trace', { pageId: A }), 75000),
  ]);
  const el11 = Date.now() - t11;
  console.log(`T11 concurrent stops (${el11}ms): A=`, brief(st_a), '| B=', brief(st_b));
  report('T11 concurrent stop_trace same trace', `(${el11}ms) stopA=${brief(st_a)} | stopB=${brief(st_b)} | hangDetected=${st_a.timeout || st_b.timeout || el11 > 55000}`);

  // ---------- T12: close tab mid-trace ----------
  const { p: E } = await newTab('https://example.com');
  await sleep(1200);
  await timed(call('performance_start_trace', { pageId: E }), 10000);
  await sleep(500);
  const closeE = await timed(call('close_page', { pageId: E }), 10000);
  await sleep(500);
  const stopDead = await timed(call('performance_stop_trace', { pageId: E }), 15000);
  const sanityOther = await timed(call('list_console_messages', { pageId: A }), 15000);
  console.log('T12 close-mid-trace:', brief(closeE), '| stop-on-dead-tab:', brief(stopDead), '| sanity:', brief(sanityOther));
  report('T12 close tab mid-trace', `close=${brief(closeE)} | stopDead=${brief(stopDead)} | otherTabOK=${!isErr(sanityOther)}`);

  // ---------- T13: stop_trace is idempotent? second call after good stop ----------
  await timed(call('performance_start_trace', { pageId: A }), 10000);
  await sleep(500);
  const g1 = await timed(call('performance_stop_trace', { pageId: A }), 30000);
  const g2 = await timed(call('performance_stop_trace', { pageId: A }), 15000);
  console.log('T13 good-stop:', brief(g1), '| second-stop:', brief(g2));
  report('T13 stop after stop', `first=${brief(g1)} | second=${brief(g2)}`);

  // ---------- post health ----------
  const health1 = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
  console.log('final health:', JSON.stringify(health1));
} finally {
  // cleanup: stop any stray traces, detach debuggers, close my tabs
  for (const id of tabs.mine) {
    try { await timed(call('performance_stop_trace', { pageId: id }), 8000); } catch {}
    try { await timed(call('detach_debugger', { pageId: id }), 8000); } catch {}
    const r = await timed(call('close_page', { pageId: id }), 8000);
    console.log('cleanup close', id, brief(r));
  }
}

console.log('\n================ SUMMARY ================');
for (const [n, s] of R) console.log(`* ${n}: ${s}`);
