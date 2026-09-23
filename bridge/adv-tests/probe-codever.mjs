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
const lp = await call('list_pages', {});
const tabs = lp.sc?.items || JSON.parse(lp.t);
const pid = tabs[0].pageId;
console.log('pid', pid);
const show = (r) => JSON.stringify(r).slice(0, 220);
console.log('cpu500:', show(await call('emulate', { pageId: pid, cpuThrottlingRate: 500 })));
console.log('waitForSel:', show(await call('wait_for', { pageId: pid, selector: '#x' })));
console.log('evalMap:', show(await call('evaluate_script', { pageId: pid, function: '() => new Map([["a",1]])' })));
console.log('evalTimeout:', show(await call('evaluate_script', { pageId: pid, function: '() => new Promise(()=>{})', timeout: 3000 })));
process.exitCode = 0;
