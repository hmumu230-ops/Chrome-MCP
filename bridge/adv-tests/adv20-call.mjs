// adv20 persistent-session MCP caller.
// usage: node adv20-call.mjs <tool> '<json-args>' [timeoutMs]
// Reuses a session id stored in adv20.sid; only re-inits on 404/410 or missing sid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const SID_FILE = path.join(dir, 'adv20.sid');
const BASE = 'http://127.0.0.1:7890/mcp';
const t0 = Date.now();
const log = (...a) => console.error(`[+${Date.now() - t0}ms]`, ...a);

let sid = fs.existsSync(SID_FILE) ? fs.readFileSync(SID_FILE, 'utf8').trim() : null;
if (!sid) sid = null;

async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (res.headers.get('mcp-session-id')) {
    sid = res.headers.get('mcp-session-id');
    fs.writeFileSync(SID_FILE, sid);
  }
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  let body;
  try { body = JSON.parse(dataLine || t); } catch { body = { raw: t, status: res.status }; }
  return { status: res.status, body };
}

async function init() {
  for (let i = 0; i < 40; i++) {
    sid = null;
    const r = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv20', version: '0' } });
    if (sid) { fs.writeFileSync(SID_FILE, sid); log('new session', sid.slice(0, 8)); return; }
    if (i % 8 === 0) log('init retry', i, 'status', r.status);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('could not initialize session (pool full)');
}

const [tool, argsJson] = process.argv.slice(2);
const TIMEOUT = Number(process.argv[4] || 45000);
let args = {};
try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { console.log('ARG-PARSE-ERR ' + e.message); process.exit(2); }

if (!sid) await init();

for (let attempt = 0; attempt < 3; attempt++) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await req('tools/call', { name: tool, arguments: args }, 2);
    clearTimeout(to);
    if (r.status === 404 || r.status === 400 || r.status === 410) { log('session lost, re-init'); await init(); continue; }
    const res = r.body.result;
    if (!res && r.body.error) { console.log(JSON.stringify({ ms: Date.now() - t0, isError: true, text: 'JSONRPC ' + JSON.stringify(r.body.error) })); process.exit(0); }
    const text = (res && res.content || []).map(c => c.text || `[${c.type}]`).join('\n');
    const out = { ms: Date.now() - t0, isError: !!(res && res.isError), text, sc: res && res.structuredContent };
    if (res && res.isError && /extension call timeout|extension disconnected|not connected/i.test(text) && attempt < 2) {
      log('transient ext err, retry', attempt); await new Promise(r => setTimeout(r, 1200)); continue;
    }
    console.log(JSON.stringify(out, null, 1).slice(0, 8000));
    process.exit(0);
  } catch (e) {
    clearTimeout(to);
    if (attempt < 2) { log('abort/err, retry', attempt, e.message); await new Promise(r => setTimeout(r, 1200)); continue; }
    console.log(JSON.stringify({ ms: Date.now() - t0, isError: true, text: 'CLIENT-TIMEOUT ' + e.message }));
    process.exit(0);
  }
}
