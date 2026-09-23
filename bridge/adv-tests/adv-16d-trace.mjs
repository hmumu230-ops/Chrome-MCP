// adv-16d-trace.mjs — minimal resilient T7: trace real page -> filePath, verify JSON.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpcRaw = async b => {
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
const rpc = async (b, tries = 4) => {
  for (let k = 0; k < tries; k++) {
    try { return await rpcRaw(b); }
    catch (e) { if (k === tries - 1) throw e; await new Promise(r => setTimeout(r, 1500 * (k + 1))); }
  }
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16d', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => !r ? '<none>' : (isErr(r) ? 'ERR ' : 'ok  ') + txt(r).replace(/\s+/g, ' ').slice(0, 200);

const np = await call('new_page', { url: 'https://en.wikipedia.org/wiki/Software_testing', background: true });
const W = (sc(np) || {}).pageId;
console.log('W =', W, brief(np));
if (!W) process.exit(1);
try {
  await sleep(3000);
  const traceFile = 'D:\\Tool\\chrome-mcp\\bridge\\test-out\\adv16\\trace-wiki.json';
  try { fs.unlinkSync(traceFile); } catch {}
  const st = await call('performance_start_trace', { pageId: W });
  console.log('start:', brief(st));
  await sleep(2500);
  await call('evaluate_script', { pageId: W, function: `() => { window.scrollBy(0,600); return 1 }` }).catch(e => console.log('eval rpc fail', e.message));
  await sleep(800);
  const t0 = Date.now();
  const stop = await call('performance_stop_trace', { pageId: W, filePath: traceFile });
  console.log(`stop (${Date.now() - t0}ms):`, brief(stop));
  try {
    const stat = fs.statSync(traceFile);
    const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    const evts = parsed.traceEvents || [];
    const names = new Set(evts.map(e => e.name));
    const cats = new Set(evts.map(e => e.cat));
    const hasTs = evts.every(e => typeof e.ts === 'number' || e.ts === undefined);
    console.log(`FILE: size=${stat.size}B events=${evts.length} allHaveTs=${hasTs}`);
    console.log(`  names: ${[...names].slice(0, 15).join(', ')}`);
    console.log(`  cats : ${[...cats].slice(0, 8).join(', ')}`);
  } catch (e) { console.log('FILE FAIL:', e.message); }
  // metrics sanity
  const m = (sc(stop) || {}).metrics || {};
  console.log('metrics keys sample:', Object.keys(m).slice(0, 8).join(','));
} finally {
  try { await call('performance_stop_trace', { pageId: W }); } catch {}
  try { await call('detach_debugger', { pageId: W }); } catch {}
  try { await call('close_page', { pageId: W }); } catch {}
  console.log('cleaned W=' + W);
}
