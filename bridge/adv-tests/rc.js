// MCP caller with cookie-value redaction — never prints real cookie values.
// usage: node rc.js <tool> '<json>'   (env MCP_ARGS overrides argv json)
const BASE = 'http://127.0.0.1:7890/mcp';

async function post(body, sid) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const nsid = res.headers.get('mcp-session-id');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      try {
        const j = JSON.parse(l.slice(5).trim());
        if (j && j.id !== undefined) { reader.cancel().catch(() => {}); return { j, sid: nsid, status: res.status }; }
      } catch {}
    }
  }
  try { return { j: JSON.parse(buf), sid: nsid }; } catch { return { raw: buf.slice(0, 3000), sid: nsid, status: res.status }; }
}

function redact(o) {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'value' && typeof v === 'string' && v.length > 3) out[k] = `<redacted len=${v.length} sha-ish=${[...v].reduce((a, c) => a + c.charCodeAt(0), 0) % 9973}>`;
      else if (k === 'body' && typeof v === 'string' && v.length > 800) out[k] = v.slice(0, 800) + `...[truncated ${v.length}]`;
      else out[k] = redact(v);
    }
    return out;
  }
  return o;
}

const tool = process.argv[2];
const raw = process.env.MCP_ARGS || process.argv[3];
const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv12', version: '0' } } });
if (!init.j || init.j.error) { console.log('INIT FAIL:', JSON.stringify(init).slice(0, 1500)); process.exit(1); }
const sid = init.sid;
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid).catch(() => {});
const t0 = Date.now();
const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: raw ? JSON.parse(raw) : {} } }, sid);
console.log(`[+${Date.now() - t0}ms]`);
let res = (r.j && (r.j.result ?? r.j)) ?? r;
// redact inside text content too
if (res && res.content) {
  res = { ...res, content: res.content.map(c => {
    if (c.type === 'text' && typeof c.text === 'string') {
      try { const parsed = JSON.parse(c.text); return { ...c, text: JSON.stringify(redact(parsed), null, 1) }; } catch { return c; }
    }
    return c;
  }) };
}
res = redact(res);
let s = JSON.stringify(res, null, 1);
console.log(s.length > 6000 ? s.slice(0, 6000) + `\n...[truncated, total ${s.length} chars]` : s);
// free the session slot (MAX_SESSIONS=50)
try { await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': sid } }); } catch {}
process.exit(0);
