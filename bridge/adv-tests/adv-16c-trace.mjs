// adv-16c-trace.mjs — part 3: T7 retest (filePath on clean tab) + run-1 orphan check.
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
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16c', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => !r ? '<none>' : r.timeout ? `<TIMEOUT ${r.ms}ms>` : (isErr(r) ? 'ERR ' : 'ok  ') + txt(r).replace(/\s+/g, ' ').slice(0, 200);
const timed = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true, ms }))]);
const R = [];
const report = (n, s) => { R.push([n, s]); console.log(`\n### ${n}\n${s}`); };

const mine = [];
try {
  // ---------- orphan check: list pages ----------
  const lp = await call('list_pages', {});
  const lpSc = sc(lp) || {};
  const pages = Array.isArray(lpSc) ? lpSc : (lpSc.items || []);
  console.log('open tabs:', pages.length);
  for (const p of pages) console.log('  ', p.pageId, (p.url || '').slice(0, 90));

  // ---------- T7 retest: trace real page (wikipedia) -> filePath ----------
  const np = await call('new_page', { url: 'https://en.wikipedia.org/wiki/Software_testing', background: true });
  if (isErr(np) || !(sc(np) || {}).pageId) throw new Error('new_page failed: ' + brief(np));
  const W = sc(np).pageId; mine.push(W);
  await sleep(3500);
  const traceFile = 'D:\\Tool\\chrome-mcp\\bridge\\test-out\\adv16\\trace-wiki.json';
  try { fs.unlinkSync(traceFile); } catch {}
  const st = await timed(call('performance_start_trace', { pageId: W }), 15000);
  console.log('T7 start:', brief(st));
  await sleep(3000);
  // generate some activity during the trace
  await timed(call('evaluate_script', { pageId: W, function: `() => { window.scrollBy(0,800); return document.title }` }), 10000);
  await sleep(1200);
  const t0 = Date.now();
  const stop = await timed(call('performance_stop_trace', { pageId: W, filePath: traceFile }), 40000);
  let fileInfo;
  try {
    const stat = fs.statSync(traceFile);
    const raw = fs.readFileSync(traceFile, 'utf8');
    const parsed = JSON.parse(raw);
    const evts = parsed.traceEvents;
    const names = new Set((evts || []).map(e => e.name));
    const cats = new Set((evts || []).map(e => e.cat));
    fileInfo = `size=${stat.size}B validJSON=true events=${Array.isArray(evts) ? evts.length : 'N/A'} names=${[...names].slice(0, 12).join(',')} cats=${[...cats].slice(0, 6).join(',')}`;
  } catch (e) { fileInfo = 'FAIL: ' + e.message; }
  console.log(`T7 stop+file (${Date.now() - t0}ms):`, brief(stop));
  console.log('T7 file:', fileInfo);
  report('T7 trace filePath on real page', `stop=${brief(stop)} | ${fileInfo}`);

  // ---------- T7b: stop without filePath (inline behavior) ----------
  const st2 = await timed(call('performance_start_trace', { pageId: W }), 15000);
  await sleep(1200);
  const stop2 = await timed(call('performance_stop_trace', { pageId: W }), 30000);
  console.log('T7b no-filePath stop:', brief(stop2), '| inlineContentHasTraceEvents=', txt(stop2).includes('traceEvents'));
  report('T7b stop without filePath', brief(stop2));

  // ---------- T15: double-detach (idempotent) ----------
  const d1 = await timed(call('detach_debugger', { pageId: W }), 10000);
  const d2 = await timed(call('detach_debugger', { pageId: W }), 10000);
  const d3 = await timed(call('detach_debugger', { pageId: W }), 10000);
  console.log('T15 detach x3:', brief(d1), '||', brief(d2), '||', brief(d3));
  report('T15 repeated detach_debugger', `${brief(d1)} | ${brief(d2)} | ${brief(d3)}`);

  // ---------- T16: start -> immediate stop (minimal trace) ----------
  const { p: Q } = await (async () => { const r = await call('new_page', { url: 'https://example.com', background: true }); mine.push(sc(r).pageId); return { p: sc(r).pageId }; })();
  await sleep(1200);
  const q1 = await timed(call('performance_start_trace', { pageId: Q }), 15000);
  const q2 = await timed(call('performance_stop_trace', { pageId: Q }), 30000); // zero dwell
  console.log('T16 instant stop:', brief(q1), '->', brief(q2));
  report('T16 start+immediate stop', `start=${brief(q1)} stop=${brief(q2)}`);

} finally {
  for (const id of mine) {
    try { await timed(call('performance_stop_trace', { pageId: id }), 8000); } catch {}
    try { await timed(call('detach_debugger', { pageId: id }), 8000); } catch {}
    console.log('cleanup close', id, brief(await timed(call('close_page', { pageId: id }), 8000)));
  }
}
console.log('\n================ SUMMARY ================');
for (const [n, s] of R) console.log(`* ${n}: ${s}`);
