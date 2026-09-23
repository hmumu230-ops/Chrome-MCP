// adv-09: network capture fidelity driver. Keeps one MCP session.
// usage: node adv-09.mjs <phaseFile or 'all'>
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;

async function rpc(method, params, timeoutMs = 130000) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc._id, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      try { const j = JSON.parse(l.slice(5)); if (j && j.id !== undefined) { reader.cancel().catch(() => {}); return j; } } catch {}
    }
  }
  try { return JSON.parse(buf); } catch { return { raw: buf.slice(0, 2000), status: res.status }; }
}
rpc._id = 0;

const TRANSIENT = /extension call timeout|extension disconnected|not connected|fetch failed|stale|404|server.*restart|socket|ECONNREFUSED|terminated/i;
function isTransient(res) {
  if (!res) return true;
  if (res.status && res.status >= 400) return true; // stale session 404 etc
  if (res.raw !== undefined) return true;           // unparsable/non-json reply
  if (res.error) return TRANSIENT.test(JSON.stringify(res.error));
  if (res.isError) {
    const t = (res.content || []).map(c => c.text || '').join(' ');
    return TRANSIENT.test(t);
  }
  return false;
}
export async function call(tool, args = {}, retries = 8) {
  let last;
  for (let i = 0; i <= retries; i++) {
    let r;
    try { r = await rpc('tools/call', { name: tool, arguments: args }); }
    catch (e) { last = { err: String(e) }; if (i < retries) { await init().catch(() => {}); await new Promise(x => setTimeout(x, 4000)); continue; } throw e; }
    const res = r.result ?? r;
    if (!isTransient(res)) return res;
    last = res;
    if (i < retries) { await init().catch(() => {}); await new Promise(x => setTimeout(x, 4000)); }
  }
  return last;
}
export async function init(retries = 15) {
  for (let i = 0; ; i++) {
    try {
      sid = null;
      const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv09', version: '0' } });
      if (r.error) throw new Error('init ' + JSON.stringify(r.error));
      await rpc('notifications/initialized', {}).catch(() => {});
      return;
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise(x => setTimeout(x, 4000));
    }
  }
}
export function slim(res) {
  // extract readable payload from MCP result
  if (res && res.structuredContent) return res.structuredContent;
  if (res && res.content) {
    const t = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { return JSON.parse(t); } catch { return t; }
  }
  return res;
}
export async function evalJs(pageId, src, extra = {}) {
  const r = await call('evaluate_script', { pageId, function: src, ...extra });
  return slim(r);
}
export async function netList(pageId, args = {}) {
  return slim(await call('list_network_requests', { pageId, ...args }));
}
export async function netGet(pageId, reqid, extra = {}) {
  return slim(await call('get_network_request', { pageId, reqid, ...extra }));
}
if (process.argv[1] && process.argv[1].endsWith('adv-09.mjs')) {
  await init();
  const [tool, json] = process.argv.slice(2);
  const out = await call(tool, json ? JSON.parse(json) : {});
  console.log(JSON.stringify(slim(out), null, 1).slice(0, 8000));
}
