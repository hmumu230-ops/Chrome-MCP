// adv-13-shot2.mjs — supplementary: parallel captureVisibleTab granularity + recovery.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  return { msg: m[m.length - 1], status: r.status };
};
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const res = r => r?.msg?.result;
const isErr = r => !!res(r)?.isError;
const txt = r => (res(r)?.content?.[0]?.text || '').replace(/\n/g, ' | ').slice(0, 200);
const kind = r => isErr(r) ? 'ERR ' + txt(r) : (res(r)?.content?.[0]?.type === 'image' ? 'IMG ' + res(r).content[0].mimeType : txt(r));
const sc = r => res(r)?.structuredContent;

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const np = await call('new_page', { url: 'https://example.com' });
const A = sc(np)?.pageId;
await call('select_page', { pageId: A, bringToFront: true });
console.log('pageId', A, 'active:', (sc(await call('list_pages', {}))?.items || []).find(t => t.pageId === A)?.active);

// sequential baseline
console.log('seq1:', kind(await call('take_screenshot', { pageId: A })));
// 2 parallel
const p2 = await Promise.all([call('take_screenshot', { pageId: A }), call('take_screenshot', { pageId: A })]);
console.log('par2:', p2.map(kind));
// sequential right after burst
console.log('seq2:', kind(await call('take_screenshot', { pageId: A })));
// 3 parallel spaced ~120ms (staggered)
const p3 = await Promise.all([0, 120, 240].map(d => new Promise(r => setTimeout(r, d)).then(() => call('take_screenshot', { pageId: A }))));
console.log('par3-staggered:', p3.map(kind));
// 5 parallel on a BACKGROUND tab (CDP path)
const nb = await call('new_page', { url: 'https://example.com', background: true });
const B2 = sc(nb)?.pageId;
const p5 = await Promise.all([...Array(5)].map(() => call('take_screenshot', { pageId: B2 })));
console.log('par5-bg(CDP):', p5.map(r => isErr(r) ? 'ERR ' + txt(r) : 'IMG ' + res(r).content[0].data.length + 'b64'));

await call('detach_debugger', { pageId: A }); await call('detach_debugger', { pageId: B2 });
await call('close_page', { pageId: A }); await call('close_page', { pageId: B2 });
console.log('done');
