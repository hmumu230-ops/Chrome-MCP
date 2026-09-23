// usage: node call.mjs <tool> '<json-args>' [timeoutMs]
// Prints elapsed ms + result or TIMEOUT.
const BASE = 'http://127.0.0.1:7890/mcp';
const timeoutMs = Number(process.argv[4] || 25000);
let sid = null;
async function req(method, params, id) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  try {
    const res = await fetch(BASE, { method: 'POST', headers, signal: ac.signal, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
    const txt = await res.text();
    const dataLine = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
    try { return JSON.parse(dataLine || txt); } catch { return { raw: txt }; }
  } finally { clearTimeout(t); }
}
const t0 = Date.now();
const el = () => Date.now() - t0;
try {
  const init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv14', version: '0' } }, 1);
  if (init.error) { console.log('INIT_FAIL', JSON.stringify(init.error)); process.exit(1); }
  const [tool, argsJson0] = process.argv.slice(2);
  const argsJson = process.env.MCP_ARGS || argsJson0;
  const t1 = Date.now();
  const r = await req('tools/call', { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} }, 2);
  console.log(`CALL_MS=${Date.now() - t1} TOTAL_MS=${el()}`);
  console.log(JSON.stringify(r.result ?? r, null, 1).slice(0, 6000));
} catch (e) {
  console.log(`CLIENT_TIMEOUT_or_ERR TOTAL_MS=${el()} ${e.name} ${e.message}`);
  process.exit(2);
}
