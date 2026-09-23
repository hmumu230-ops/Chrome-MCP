const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(m, p = {}) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
  if (!sid) sid = r.headers.get('mcp-session-id');
  const t = await r.text();
  const dl = t.split('\n').find(l => l.startsWith('data: '));
  return { status: r.status, body: JSON.parse(dl ? dl.slice(6) : t) };
}
const call = async (n, a) => {
  const { body } = await req('tools/call', { name: n, arguments: a });
  if (body.error) return { err: body.error };
  const res = body.result || {};
  return { e: res.isError, t: res.content?.[0]?.text || '', sc: res.structuredContent };
};
await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } });
const np = await call('new_page', { url: 'https://example.com', background: false });
const pid = np.sc?.pageId || JSON.parse(np.t).pageId;
await new Promise(r => setTimeout(r, 2500));
const snap = await call('take_snapshot', { pageId: pid });
console.log('SNAP>>>', snap.e ? snap.t : (snap.sc?.lines || []).join('\n').slice(0, 600));
const et = await call('extract_text', { pageId: pid });
console.log('TEXT>>>', (et.t || '').slice(0, 200));
const dl = await call('list_downloads', { limit: 10 });
console.log('DLS>>>', (dl.t || '').slice(0, 400));
// link click navigation
const lm = (snap.sc?.lines || []).find(l => /link.*Learn more/i.test(l));
const uid = lm && lm.match(/\[([^\]]+)\]/)[1];
console.log('linkuid:', uid, 'line:', lm);
if (uid) {
  const c = await call('click', { pageId: pid, uid });
  await new Promise(r => setTimeout(r, 2000));
  const lp = await call('list_pages', {});
  const tab = (lp.sc?.items || JSON.parse(lp.t)).find(t => t.pageId === pid);
  console.log('CLICK>>>', JSON.stringify(c).slice(0, 120), '→', tab && tab.url);
}
await call('close_page', { pageId: pid });
process.exitCode = 0;
