// adv-15 cleanup: find leftover test tabs (loopback status page / echo / chrome://version / about:blank
// opened by my runs) and close only those; verify no residual emulation.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, nextId = 1;
async function rpc(m, p) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(BASE, { method: 'POST', headers: h, signal: AbortSignal.timeout(25000), body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: m, params: p }) });
  const ns = r.headers.get('mcp-session-id'); if (ns) sid = ns;
  const t = await r.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return { status: r.status, raw: t.slice(0, 200) }; }
}
async function call(n, a) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = (await rpc('tools/call', { name: n, arguments: a || {} })).result ?? {};
      const t = r.content && r.content[0] ? r.content[0].text : '';
      if (/extension call timeout|disconnected|not connected/i.test(t)) { await new Promise(x => setTimeout(x, 1500)); continue; }
      return r;
    } catch { sid = null; await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } }).catch(() => {}); }
  }
  return { isError: true, content: [{ type: 'text', text: 'Error: unreachable' }] };
}
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } });
const lp = await call('list_pages');
const tabs = (lp.structuredContent && (lp.structuredContent.items || lp.structuredContent)) || [];
console.log('total tabs:', Array.isArray(tabs) ? tabs.length : '?');
const mine = tabs.filter(t => /127\.0\.0\.1:(7890|8199)/.test(t.url || '') || /chrome:\/\/version/.test(t.url || '') || t.url === 'about:blank');
for (const t of mine) console.log('candidate:', t.pageId, JSON.stringify(t.url), 'active=' + t.active);
// Conservative: only close tabs I can attribute to my runs — the known part-A
// orphan id, or URLs carrying my distinctive query markers (?nav=, ?land=, ?cb=).
const KNOWN_MINE = new Set([301370769]);
const MY_URL = /[?&](nav|land|cb)=/;
for (const t of mine) {
  const close = KNOWN_MINE.has(t.pageId) || MY_URL.test(t.url || '');
  if (!close) { console.log('skip (not mine):', t.pageId, t.url); continue; }
  const e1 = await call('emulate', { pageId: t.pageId, viewport: '', cpuThrottlingRate: 1, userAgent: '', colorScheme: 'auto', geolocation: '', extraHttpHeaders: '' });
  console.log('reset', t.pageId, '->', (e1.content && e1.content[0].text || '').slice(0, 90).replace(/\n/g, ' '));
  await call('detach_debugger', { pageId: t.pageId });
  const c = await call('close_page', { pageId: t.pageId });
  console.log('close', t.pageId, '->', (c.content && c.content[0].text || '').slice(0, 90).replace(/\n/g, ' '));
}
const lp2 = await call('list_pages');
const tabs2 = (lp2.structuredContent && (lp2.structuredContent.items || lp2.structuredContent)) || [];
const left = tabs2.filter(t => /^http:\/\/127\.0\.0\.1:(7890|8199)/.test(t.url || '') || /chrome:\/\/version/.test(t.url || ''));
console.log('remaining candidate tabs:', left.length, JSON.stringify(left.map(t => t.pageId)));
console.log('done');
