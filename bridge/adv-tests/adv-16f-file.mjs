// adv-16f-file.mjs — T7 final: trace -> filePath in %TEMP% (non-protected), verify JSON.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc1 = async b => {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(b),
  });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  return { msg: m[m.length - 1], status: r.status };
};
const rpc = async (b, tries = 8) => {
  for (let k = 0; k < tries; k++) {
    try { const r = await rpc1(b); if (r.status === 200 && r.msg) return r; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { msg: null, status: 0 };
};
for (let k = 0; k < 30; k++) {
  try { const h = await fetch(BASE.replace('/mcp', '/'), { signal: AbortSignal.timeout(3000) }).then(r => r.json()); if (h.extensionConnected) break; } catch {}
  await new Promise(r => setTimeout(r, 3000));
}
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16f', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => !r || !r.msg ? '<no/empty response>' : (isErr(r) ? 'ERR ' : 'ok  ') + txt(r).replace(/\s+/g, ' ').slice(0, 220);

const np = await call('new_page', { url: 'https://en.wikipedia.org/wiki/Software_testing', background: true });
const W = (sc(np) || {}).pageId;
console.log('W =', W, '|', brief(np));
if (W) {
  try {
    await sleep(3000);
    const traceFile = (process.env.TEMP || 'C:\\Users\\29980\\AppData\\Local\\Temp') + '\\adv16-trace.json';
    try { fs.unlinkSync(traceFile); } catch {}
    const st = await call('performance_start_trace', { pageId: W });
    console.log('start:', brief(st));
    await sleep(3000);
    await call('evaluate_script', { pageId: W, function: `() => { window.scrollBy(0,700); return 1 }` });
    await sleep(1000);
    const t0 = Date.now();
    const stop = await call('performance_stop_trace', { pageId: W, filePath: traceFile });
    console.log(`stop (${Date.now() - t0}ms):`, brief(stop));
    try {
      const stat = fs.statSync(traceFile);
      const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
      const evts = parsed.traceEvents || [];
      const names = new Set(evts.map(e => e.name));
      console.log(`FILE: ${traceFile} size=${stat.size}B events=${evts.length} validJSON=true`);
      console.log(`  event names: ${[...names].slice(0, 15).join(', ')}`);
      const m = (sc(stop) || {}).metrics || {};
      console.log('  metrics:', Object.keys(m).slice(0, 6).map(k => `${k}=${Math.round(m[k] * 100) / 100}`).join(', '));
    } catch (e) { console.log('FILE FAIL:', e.message); }
  } finally {
    console.log('cleanup stop:', brief(await call('performance_stop_trace', { pageId: W })));
    console.log('cleanup detach:', brief(await call('detach_debugger', { pageId: W })));
    console.log('cleanup close:', brief(await call('close_page', { pageId: W })));
  }
}
console.log('done');
