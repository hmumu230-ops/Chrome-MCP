// Call one tool and print the full result (waits for real response, not keepalives).
// usage: node call.js <tool> '<json>'   — env MCP_ARGS overrides argv json
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
  try { return { j: JSON.parse(buf), sid: nsid }; } catch { return { raw: buf.slice(0, 2000), sid: nsid, status: res.status }; }
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
let s = JSON.stringify((r.j && (r.j.result ?? r.j)) ?? r, null, 1);
console.log(s.length > 6000 ? s.slice(0, 6000) + `\n...[truncated, total ${s.length} chars]` : s);
process.exit(0);
