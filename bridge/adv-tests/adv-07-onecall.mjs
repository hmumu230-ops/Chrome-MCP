// adv-07-onecall.mjs <tool> <json-args-file> — single MCP call, full print.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return t; }
}
let init;
for (let k = 0; k < 30; k++) {
  init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli', version: '0' } });
  if (sid) break;
  console.error('init retry', k, typeof init === 'string' ? init.slice(0, 60) : JSON.stringify(init).slice(0, 80));
  await new Promise(r => setTimeout(r, 4000));
}
if (!sid) { console.error('no session'); process.exit(1); }
const [tool, argsFile] = process.argv.slice(2);
const raw = fs.readFileSync(argsFile, 'utf8');
const r = await req('tools/call', { name: tool, arguments: JSON.parse(raw) }, 2);
console.log(JSON.stringify(r.result ?? r, null, 1).slice(0, 6000));
