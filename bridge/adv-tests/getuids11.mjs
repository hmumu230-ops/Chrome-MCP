const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  for (let att = 0; att < 8; att++) {
    const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.status === 503) { await new Promise(r => setTimeout(r, 1500)); continue; }
    if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
    const t = await res.text();
    const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
    try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: t }; }
  }
  return { status: 503, body: 'retry exhausted' };
}
await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11-uids', version: '0' } });
const pageId = Number(process.argv[2]);
const r = await req('tools/call', { name: 'take_snapshot', arguments: { pageId } }, 2);
const c = r.body.result && r.body.result.content;
const text = c && c.map(x => x.text).join('\n');
console.log('TEXTLEN', text && text.length);
const lines = (text || '').split('\n');
const uidLines = lines.filter(l => /\[[^\]]+\]/.test(l) || /iframe|frameId/i.test(l));
console.log('UIDLINES', uidLines.length);
console.log(uidLines.join('\n').slice(0, 3000));
console.log('---TAIL---');
console.log((text || '').slice(-1500));
process.exit(0);
