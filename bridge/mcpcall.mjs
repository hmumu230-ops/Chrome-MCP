// usage: node mcpcall.mjs <tool> '<json-args>'
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dataLine || t); } catch { return t; }
}
const init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli', version: '0' } });
if (init.error) { console.error('init failed', init); process.exitCode = 1; }
else {
  const [tool, argsJson] = process.argv.slice(2);
  const raw = process.env.MCP_ARGS || argsJson;
  const r = await req('tools/call', { name: tool, arguments: raw ? JSON.parse(raw) : {} }, 2);
  console.log(JSON.stringify(r.result ?? r, null, 1).slice(0, 4000));
}
