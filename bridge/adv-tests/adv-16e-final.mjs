// adv-16e-final.mjs — resilient final pass: wait for extension, T7 file verify,
// close tabs that are clearly mine (wikipedia Main_Page / Software_testing).
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
const rpc = async (b, tries = 6) => {
  for (let k = 0; k < tries; k++) {
    try { const r = await rpc1(b); if (r.status === 200 && r.msg) return r; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return { msg: null, status: 0 };
};
// wait for extension to connect (up to ~90s)
for (let k = 0; k < 30; k++) {
  try { const h = await fetch(BASE.replace('/mcp', '/'), { signal: AbortSignal.timeout(3000) }).then(r => r.json()); if (h.extensionConnected) break; } catch {}
  await new Promise(r => setTimeout(r, 3000));
}
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv16e', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => {
  const r = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
  return r;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = r => ((r.msg && r.msg.result && r.msg.result.content) || []).map(c => c.text || '').join('\n');
const isErr = r => !!(r.msg && ((r.msg.result && r.msg.result.isError) || r.msg.error));
const sc = r => r.msg && r.msg.result && r.msg.result.structuredContent;
const brief = r => !r || !r.msg ? '<no/empty response>' : (isErr(r) ? 'ERR ' : 'ok  ') + txt(r).replace(/\s+/g, ' ').slice(0, 200);

// 1) list tabs, find mine
const lp = await call('list_pages', {});
const lpSc = sc(lp) || {};
const pages = Array.isArray(lpSc) ? lpSc : (lpSc.items || []);
console.log('tabs:', pages.length, '| list err?', isErr(lp));
const myWikis = pages.filter(p => /wikipedia\.org\/wiki\/(Main_Page|Software_testing)/.test(p.url || ''));
for (const p of pages) console.log('  ', p.pageId, (p.url || '').slice(0, 95));
console.log('my wikipedia tabs:', JSON.stringify(myWikis.map(t => t.pageId)));

// 2) T7 trace -> file on a wikipedia tab (reuse existing mine or open new)
let W = myWikis[0] && myWikis[0].pageId;
let openedW = false;
if (!W) {
  const np = await call('new_page', { url: 'https://en.wikipedia.org/wiki/Software_testing', background: true });
  W = (sc(np) || {}).pageId; openedW = !!W;
  console.log('new wiki tab W=', W, brief(np));
}
if (W) {
  const traceFile = 'D:\\Tool\\chrome-mcp\\bridge\\test-out\\adv16-trace.json';
  try { fs.unlinkSync(traceFile); } catch {}
  const st = await call('performance_start_trace', { pageId: W });
  console.log('start:', brief(st));
  if (!isErr(st)) {
    await sleep(3000);
    const t0 = Date.now();
    const stop = await call('performance_stop_trace', { pageId: W, filePath: traceFile });
    console.log(`stop (${Date.now() - t0}ms):`, brief(stop));
    try {
      const stat = fs.statSync(traceFile);
      const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
      const evts = parsed.traceEvents || [];
      const names = new Set(evts.map(e => e.name));
      console.log(`FILE: size=${stat.size}B events=${evts.length} validJSON=true`);
      console.log(`  names: ${[...names].slice(0, 15).join(', ')}`);
      const m = (sc(stop) || {}).metrics || {};
      console.log('  metrics sample:', Object.keys(m).slice(0, 6).map(k => `${k}=${Math.round(m[k] * 100) / 100}`).join(', '));
    } catch (e) { console.log('FILE FAIL:', e.message); }
  }
}

// 3) cleanup: stop+detach+close my wikipedia tabs (+ newly opened one)
for (const t of [...myWikis.map(t => t.pageId), openedW ? W : null].filter(x => x != null)) {
  console.log('cleanup tab', t);
  console.log('  stop:', brief(await call('performance_stop_trace', { pageId: t })));
  console.log('  detach:', brief(await call('detach_debugger', { pageId: t })));
  console.log('  close:', brief(await call('close_page', { pageId: t })));
}
console.log('done');
