// adv-01-http.mjs — adversarial HTTP-transport tests for the chrome-mcp bridge.
// Read-only vs source. Raw TCP for byte-level control; fetch for MCP lifecycle.
// Output: one line per check + a FINDINGS section at the end.
import net from 'node:net';

const HOST = '127.0.0.1', PORT = 7890;
const GOOD_HOST = '127.0.0.1:7890';
const findings = [];
let checkN = 0;

const J = (o) => JSON.stringify(o);
const INIT = J({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv', version: '0' } } });

function parseResponse(buf) {
  const s = buf.toString('latin1');
  const hi = s.indexOf('\r\n\r\n');
  if (hi === -1) return { headersDone: false, raw: s };
  const head = s.slice(0, hi);
  const lines = head.split('\r\n');
  const m = lines[0].match(/^HTTP\/\d\.\d (\d{3})/);
  const headers = {};
  for (const l of lines.slice(1)) {
    const c = l.indexOf(':');
    if (c > 0) { const k = l.slice(0, c).trim().toLowerCase(); headers[k] = headers[k] ? headers[k] + ', ' + l.slice(c + 1).trim() : l.slice(c + 1).trim(); }
  }
  const body = s.slice(hi + 4);
  const cl = headers['content-length'] != null ? Number(headers['content-length']) : null;
  const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
  const complete = (cl != null && body.length >= cl) || (chunked && /0\r\n\r\n/.test(body));
  return { headersDone: true, status: m ? +m[1] : null, statusLine: lines[0], headers, body, complete, bodyLen: body.length };
}

// Send raw bytes, collect response. Resolves {status, headers, body, tag, ms, raw}
function req(raw, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection(PORT, HOST);
    const chunks = [];
    let done = false, settleT = null;
    const fin = (tag, extra) => {
      if (done) return; done = true; clearTimeout(settleT);
      try { sock.destroy(); } catch {}
      resolve({ tag, ms: Date.now() - t0, ...parseResponse(Buffer.concat(chunks)), ...extra });
    };
    sock.on('connect', () => sock.write(raw));
    sock.on('data', (c) => {
      chunks.push(c);
      const p = parseResponse(Buffer.concat(chunks));
      if (p.complete) return fin('ok');
      if (p.headersDone && p.status === 101) return fin('ok'); // upgrade
      clearTimeout(settleT);
      settleT = setTimeout(() => fin('ok-ish'), 400); // keep-alive: no more data coming
    });
    sock.on('close', () => fin('eof'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(timeout, () => fin('timeout'));
  });
}

function build(method, target, headers = [], body = '') {
  const h = [`${method} ${target} HTTP/1.1`, `Host: ${GOOD_HOST}`, ...headers, 'Connection: close', '', ''];
  return h.join('\r\n') + body;
}

async function check(name, rawOrFn, expect /* {status}|{oneOf}|{fn} */, note = '') {
  checkN++;
  let r;
  try { r = typeof rawOrFn === 'function' ? await rawOrFn() : await req(rawOrFn); }
  catch (e) { r = { tag: 'thrown', err: String(e && e.message || e) }; }
  let ok = false, obs;
  if (r.tag === 'thrown') obs = 'THREW ' + r.err;
  else if (r.status != null) obs = `${r.status} (${r.tag}) body=${(r.body || '').slice(0, 90).replace(/\r?\n/g, '\\n')}`;
  else obs = `no HTTP response: ${r.tag}${r.sockErr ? ' ' + r.sockErr : ''} bytes=${(r.raw || '').length}`;
  if (expect.status != null) ok = r.status === expect.status;
  else if (expect.oneOf) ok = expect.oneOf.includes(r.status);
  else if (expect.fn) ok = !!expect.fn(r);
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${checkN} ${name} -> ${obs}${note ? '   [' + note + ']' : ''}`);
  return r;
}
const FIND = (id, sev, title, repro, observed, expected) =>
  findings.push({ id, sev, title, repro, observed, expected });

async function alive() {
  const r = await req(build('GET', '/', []), { timeout: 3000 });
  return r.status === 200;
}
const ALIVE = async (where) => console.log(`    ..alive after ${where}: ${await alive()}`);

/* ---------- fetch-based MCP session ---------- */
const BASE = `http://${HOST}:${PORT}/mcp`;
let sid = null, idc = 100;
async function mcp(bodyObj, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: J(bodyObj) });
  const t = await res.text();
  if (!sid) sid = res.headers.get('mcp-session-id');
  let last = null;
  for (const l of t.split('\n')) if (l.startsWith('data:')) { try { last = JSON.parse(l.slice(5).trim()); } catch {} }
  if (!last && t.trim()) { try { last = JSON.parse(t); } catch { last = { raw: t.slice(0, 200) }; } }
  return { status: res.status, msg: last, headers: res.headers };
}

/* ================= PHASE A — non-destructive ================= */
console.log('== A1 baseline ==');
const base = await check('GET / baseline', build('GET', '/', []), { status: 200 });
const sessions0 = (() => { try { return JSON.parse(base.body).sessions; } catch { return '?'; } })();
console.log(`    baseline sessions=${sessions0}`);

console.log('== A2 Host header attacks (GET /) ==');
await check('Host: evil.com', build('GET', '/', [], '').replace('Host: ' + GOOD_HOST, 'Host: evil.com'), { status: 403 });
await check('Host: 127.0.0.1.evil.com', build('GET', '/', [], '').replace(GOOD_HOST, '127.0.0.1.evil.com'), { status: 403 });
await check('Host: evil.com:7890', build('GET', '/', [], '').replace(GOOD_HOST, 'evil.com:7890'), { status: 403 });
await check('no Host header', 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n', { status: 403 });
await check('Host empty', 'GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n', { status: 403 });
let r = await check('Host: 127.0.0.1:1 (foreign port)', build('GET', '/', [], '').replace(GOOD_HOST, '127.0.0.1:1'), { status: 200 });
if (r.status === 200) FIND('H1', 'info', 'Host check ignores port entirely', 'Host: 127.0.0.1:1', 'accepted (200)', 'acceptable — host still local; note any port allowed');
r = await check('Host: [::1]:7890 (legit IPv6 w/ port)', build('GET', '/', [], '').replace(GOOD_HOST, '[::1]:7890'), { status: 200 });
if (r.status !== 200) FIND('H2', 'low', 'Legit bracketed IPv6 Host with port rejected', 'Host: [::1]:7890', `status ${r.status}`, "host== '[::1]' should pass; split(':')[0] yields '['");
await check('Host: 127.0.0.1. trailing dot', build('GET', '/', [], '').replace(GOOD_HOST, '127.0.0.1.'), { status: 403 });
await check('Host: LOCALHOST (case)', build('GET', '/', [], '').replace(GOOD_HOST, 'LOCALHOST'), { status: 403 });
r = await check('Host: 127.0.0.1:evil (non-numeric port)', build('GET', '/', [], '').replace(GOOD_HOST, '127.0.0.1:evil'), { status: 200 });
await check('duplicate Host evil+good', 'GET / HTTP/1.1\r\nHost: evil.com\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', { status: 403 });
await check('HTTP/1.0 no Host', 'GET / HTTP/1.0\r\n\r\n', { status: 403 });
await check('HTTP/1.0 with Host', 'GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n', { oneOf: [200] });
r = await check('absolute-form target evil + good Host', 'GET http://evil.com/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', { status: 200 });
if (r.status === 200) FIND('H3', 'info', 'Absolute-URI request-target ignored for authz', 'GET http://evil.com/ w/ Host:127.0.0.1', '200 — routed by pathname only', 'harmless locally, but request-target host never checked');

console.log('== A3 Origin attacks (GET /) ==');
await check('Origin https://evil.com', build('GET', '/', ['Origin: https://evil.com']), { status: 403 });
await check('Origin null', build('GET', '/', ['Origin: null']), { status: 403 });
await check('Origin file://', build('GET', '/', ['Origin: file:///etc/passwd']), { status: 403 });
r = await check('Origin chrome-extension://FAKEID', build('GET', '/', ['Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak']), { status: 200 });
if (r.status === 200) FIND('O1', 'medium', 'Any chrome-extension:// Origin accepted on /mcp', 'GET / (or POST /mcp initialize) with Origin: chrome-extension://<any-id>', '200 — endpoint usable by ANY installed extension, not just the pinned one', 'should compare to pinned .extension-id or reject extension origins on HTTP');
await check('Origin http://127.0.0.1.evil.com', build('GET', '/', ['Origin: http://127.0.0.1.evil.com']), { status: 403 });
await check('Origin http://127.0.0.1@evil.com', build('GET', '/', ['Origin: http://127.0.0.1@evil.com']), { status: 403 });
await check('Origin http://evil.com:7890@127.0.0.1', build('GET', '/', ['Origin: http://evil.com:7890@127.0.0.1']), { status: 403 });
r = await check('Origin http://127.0.0.1:1 (any port)', build('GET', '/', ['Origin: http://127.0.0.1:1']), { status: 200 });
if (r.status === 200) FIND('O2', 'low', 'Any localhost port/scheme Origin trusted', 'Origin: http://127.0.0.1:1 or https://localhost:4443', '200', 'per-spec DNS-rebinding check is host-only; any local web app origin can drive the browser');
await check('Origin https://localhost:4443', build('GET', '/', ['Origin: https://localhost:4443']), { status: 200 });
r = await check('Origin bare 127.0.0.1 (no scheme)', build('GET', '/', ['Origin: 127.0.0.1']), { status: 200 });
if (r.status === 200) FIND('O3', 'info', 'Scheme-less Origin accepted', 'Origin: 127.0.0.1', '200', 'regex makes scheme optional; browsers always send scheme');
r = await check('Origin chrome-extension:// (bare)', build('GET', '/', ['Origin: chrome-extension://']), { status: 200 });
await check('Origin moz-extension://x', build('GET', '/', ['Origin: moz-extension://x']), { status: 403 });
await check('Origin http://127.0.0.1:7890/path', build('GET', '/', ['Origin: http://127.0.0.1:7890/path']), { status: 403 });
await check('Origin missing entirely', build('GET', '/', []), { status: 200 });
const cors = await req(build('GET', '/', ['Origin: https://evil.com']));
console.log(`    CORS headers on 403: acao=${cors.headers?.['access-control-allow-origin'] ?? 'none'} (expected none)`);

console.log('== A4 methods & paths ==');
await check('PUT /mcp', build('PUT', '/mcp', ['Content-Length: 0']), { status: 405 });
await check('OPTIONS /mcp', build('OPTIONS', '/mcp', []), { status: 405 });
await check('PATCH /mcp', build('PATCH', '/mcp', ['Content-Length: 0']), { status: 405 });
await check('TRACE /mcp', build('TRACE', '/mcp', []), { status: 405 });
await check('DELETE /mcp no session', build('DELETE', '/mcp', []), { status: 404 });
await check('GET /mcp no session', build('GET', '/mcp', []), { status: 404 });
await check('POST /', build('POST', '/', ['Content-Length: 0']), { status: 404 });
await check('HEAD /', build('HEAD', '/', []), { status: 404 });
await check('POST /mcp/', build('POST', '/mcp/', ['Content-Length: 0']), { status: 404 });
await check('POST /mcp/../', build('POST', '/mcp/../', ['Content-Length: 0']), { status: 404 });
await check('POST //mcp', build('POST', '//mcp', ['Content-Length: 0']), { status: 404 });
await check('POST /mcp/x', build('POST', '/mcp/x', ['Content-Length: 0']), { status: 404 });
await check('POST /mcp%2f', build('POST', '/mcp%2f', ['Content-Length: 0']), { status: 404 });
r = await check('POST /mcp?x=.. (query ok)', build('POST', '/mcp?x=..', ['Content-Type: application/json', 'Content-Length: 2'], '{}'), { status: 404 });
await check('GET /ws (no upgrade)', build('GET', '/ws', []), { status: 404 });
await check('POST /ws', build('POST', '/ws', ['Content-Length: 0']), { status: 404 });
await check('GET /ws?x', build('GET', '/ws?x', []), { status: 404 });
await check('CONNECT method', 'CONNECT 127.0.0.1:7890 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', { fn: (r) => r.status !== 200 });

console.log('== A5 MCP session lifecycle ==');
const init = await mcp({ jsonrpc: '2.0', id: ++idc, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv', version: '0' } } });
console.log(`    initialize -> ${init.status}, sid=${sid}`);
r = await check('init WITH bogus mcp-session-id (fixation attempt)', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: deadbeefdeadbeef', 'Content-Length: ' + Buffer.byteLength(INIT)], INIT), { status: 404 });
if (r.status !== 404) FIND('S1', 'medium', 'Session fixation possible', 'POST initialize + attacker mcp-session-id', `status ${r.status}`, 'expected 404 — should not honor client-chosen session ids');
await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
const tl = await mcp({ jsonrpc: '2.0', id: ++idc, method: 'tools/list' });
console.log(`    tools/list -> ${tl.status}, tools=${tl.msg?.result?.tools?.length ?? '?'}`);
r = await check('POST invalid JSON (no session)', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Content-Length: 1'], '{'), { status: 400 });
r = await check('POST empty body (no session)', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Content-Length: 0']), { status: 404 });
// empty body WITH session — SDK may re-read the consumed stream
r = await check('POST empty body WITH session', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: ' + sid, 'Content-Length: 0']), { oneOf: [400, 404] });
if (r.tag === 'timeout') FIND('B0', 'medium', 'Empty POST body with valid session hangs', 'POST /mcp CL:0 + valid session', 'no response within 5s', 'expected fast 400 — SDK re-reads consumed stream');
r = await check('POST invalid JSON WITH session', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: ' + sid, 'Content-Length: 3'], 'xyz'), { status: 400 });
r = await check('POST batch array w/ session', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: ' + sid, 'Content-Length: ' + Buffer.byteLength(J([{ jsonrpc: '2.0', id: 77, method: 'tools/list' }]))], J([{ jsonrpc: '2.0', id: 77, method: 'tools/list' }])), { oneOf: [200, 400, 406] });
r = await check('POST Accept: text/html only', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: text/html', 'Mcp-Session-Id: ' + sid, 'Content-Length: ' + Buffer.byteLength(INIT)], INIT), { status: 406 });
r = await check('POST Accept missing', build('POST', '/mcp', ['Content-Type: application/json', 'Mcp-Session-Id: ' + sid, 'Content-Length: ' + Buffer.byteLength(INIT)], INIT), { status: 406 });
r = await check('POST Content-Type text/plain + JSON', build('POST', '/mcp', ['Content-Type: text/plain', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: ' + sid, 'Content-Length: ' + Buffer.byteLength(INIT)], INIT), { oneOf: [400, 415] });
r = await check('re-initialize existing session', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: ' + sid, 'Content-Length: ' + Buffer.byteLength(INIT)], INIT), { status: 400 });

console.log('== A6 header-level attacks ==');
await check('bare LF inside header value', 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-T: a\nb: c\r\n\r\n', { fn: (r) => r.status === 400 || r.status === 403 || !r.status });
r = await check('NUL byte in header value', 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-T: a\0b\r\n\r\n', { fn: (r) => r.status === 400 || !r.status });
await check('obs-fold folded header', 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-T: a\r\n b\r\n\r\n', { fn: (r) => r.status === 400 || r.status === 200 || !r.status });
const bigHdr = 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ' + 'A'.repeat(64 * 1024) + '\r\n\r\n';
r = await check('64KB single header', bigHdr, { fn: (r) => r.status === 431 || r.status === 400 || !r.status });
await check('mcp-session-id with CRLF-ish garbage', build('POST', '/mcp', ['Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Mcp-Session-Id: a b\tc', 'Content-Length: 2'], '{}'), { status: 404 });
await check('double mcp-session-id', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMcp-Session-Id: ${sid}\r\nMcp-Session-Id: other\r\nContent-Length: 2\r\n\r\n{}`, { status: 404 });

console.log('== A7 concurrency / session integrity ==');
const before = (await req(build('GET', '/', []))).body;
await Promise.allSettled(Array.from({ length: 30 }, (_, i) =>
  req(build('GET', '/', i % 3 === 0 ? ['Origin: https://evil.com'] : []), { timeout: 5000 })));
const after = await req(build('GET', '/', []));
const tl2 = await mcp({ jsonrpc: '2.0', id: ++idc, method: 'tools/list' });
console.log(`    sessions before/after burst: ${before.match(/sessions":(\d+)/)?.[1]}/${after.body.match(/sessions":(\d+)/)?.[1]}, tools/list still ${tl2.status}`);
if (tl2.status !== 200) FIND('C1', 'medium', 'Rejected requests disturb live session', '30 mixed 403/200 requests then tools/list', `tools/list -> ${tl2.status}`, 'session should be unaffected');

/* ================= PHASE W — /ws upgrade (hijack primitive) ================= */
console.log('== W1 ws upgrade rejection cases ==');
const wsH = (extra) => ['GET /ws HTTP/1.1', `Host: ${GOOD_HOST}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...extra, '', ''].join('\r\n');
await check('WS upgrade Origin https://evil.com', wsH(['Origin: https://evil.com']), { fn: (r) => r.status !== 101 });
await check('WS upgrade Origin http://localhost:1', wsH(['Origin: http://localhost:1']), { fn: (r) => r.status !== 101 });
await check('WS upgrade wrong ext id', wsH(['Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak']), { fn: (r) => r.status !== 101 });
await check('WS upgrade Host evil.com', wsH(['Origin: chrome-extension://pmhfdkkgjbfngeekdbdnjdnlnhmbinoh']).replace(GOOD_HOST, 'evil.com'), { fn: (r) => r.status !== 101 });
await check('WS upgrade to /mcp', wsH([]).replace('/ws', '/mcp'), { fn: (r) => r.status !== 101 });

console.log('== W2 ws upgrade no-Origin hijack test ==');
const extBefore = (await req(build('GET', '/', []))).body.includes('"extensionConnected":true');
const hijack = await req(wsH([]), { timeout: 3000 });
if (hijack.status === 101) {
  FIND('W1', 'high', 'Unauthenticated local WS hijack of extension channel', 'WS GET /ws upgrade with NO Origin header (any local process, MCP_EXT_TOKEN unset)', '101 Switching Protocols — attacker socket becomes "the extension" (single-slot last-wins terminates the real one); all tool calls incl. evaluate_script args/cookies are routed to attacker, and attacker replies flow through formatResult() which writes arbitrary file paths to disk', 'require token or verify Origin even when absent');
} else {
  console.log(`    no-Origin upgrade -> ${hijack.status ?? hijack.tag} (rejected — good)`);
}
await new Promise(r2 => setTimeout(r2, 4000)); // let the real extension reconnect
const extAfter = (await req(build('GET', '/', []))).body.includes('"extensionConnected":true');
console.log(`    extensionConnected before=${extBefore} after(4s)=${extAfter}`);
if (extBefore && !extAfter) FIND('W2', 'medium', 'Extension did not reconnect within 4s after hijack', 'see W1', 'extensionConnected=false after 4s', 'SW backoff should recover in ~1s');

/* ================= PHASE B — potentially destructive ================= */
console.log('== B1 oversized body (declared CL > 4MiB) ==');
r = await check('CL: 5000000 declared', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 5000000\r\n\r\n` + 'x'.repeat(100), { fn: () => true });
if (r.status == null) FIND('B1', 'low', 'Oversized-body reject destroys socket instead of 413', 'POST /mcp Content-Length: 5000000', `no HTTP response (${r.tag}${r.sockErr ? ' ' + r.sockErr : ''})`, '413 + keep-alive; code calls req.destroy() then res.writeHead(413)');
await ALIVE('big declared CL');

console.log('== B2 oversized body (chunked, actual > 4MiB) ==');
const bigBody = (() => { const parts = []; for (let i = 0; i < 45; i++) parts.push('fffff\r\n' + 'y'.repeat(0xfffff) + '\r\n'); parts.push('0\r\n\r\n'); return parts.join(''); })();
r = await check('chunked ~4.7MiB', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n` + bigBody, { fn: () => true, timeout: 8000 });
if (r.status == null) FIND('B2', 'low', 'Chunked oversize reject destroys socket instead of 413', 'POST /mcp chunked >4MiB', `no HTTP response (${r.tag})`, '413 expected');
await ALIVE('big chunked body');

console.log('== B3 Content-Length lies ==');
r = await check('CL=2 but 2000 bytes sent', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 2\r\n\r\n{}` + 'Z'.repeat(2000), { fn: () => true });
console.log(`    (extra bytes are parsed as next pipelined request -> clientError expected)`);
r = await check('conflicting duplicate CL', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Length: 2\r\nContent-Length: 5\r\n\r\n{}`, { fn: () => true });
r = await check('CL + TE: chunked', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`, { fn: () => true });
r = await check('CL: abc', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Length: abc\r\n\r\n{}`, { fn: () => true });

console.log('== B4 content-encoding lies ==');
r = await check('Content-Encoding: gzip + PLAIN json init', `POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Encoding: gzip\r\nContent-Length: ${Buffer.byteLength(INIT)}\r\n\r\n${INIT}`, { oneOf: [200, 400] });
if (r.status === 200) FIND('E1', 'info', 'Content-Encoding ignored', 'CE: gzip + plaintext body', '200 — body used as-is', 'server never honors content-encoding (no decompression bomb, but dishonest)');

console.log('== B5 slow-drip body (10s server timer) ==');
{
  const t0 = Date.now();
  const drip = await new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag, extra) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ tag, ms: Date.now() - t0, ...parseResponse(Buffer.concat(chunks)), ...extra }); };
    sock.on('connect', () => {
      sock.write(`POST /mcp HTTP/1.1\r\nHost: ${GOOD_HOST}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`);
      let sent = 0;
      const iv = setInterval(() => { if (done || sock.destroyed) { clearInterval(iv); return; } sock.write('x'); if (++sent > 11) clearInterval(iv); }, 1000);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => fin('closed'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(16000, () => fin('timeout'));
  });
  checkN++;
  console.log(`    drip result: ${drip.status ?? 'no-response'} tag=${drip.tag} ms=${drip.ms}${drip.sockErr ? ' err=' + drip.sockErr : ''}`);
  if (drip.ms < 16000 && drip.status == null) FIND('B3', 'low', 'Body read timeout kills socket without error response', 'POST /mcp CL:100 then drip 1B/s', `conn destroyed ~${drip.ms}ms, no 400`, '10s timer fires (good) but res.writeHead(400) lands on destroyed socket');
}
await ALIVE('drip');

console.log('== B6 session count sanity (no unbounded growth) ==');
const sNow = (await req(build('GET', '/', []))).body.match(/sessions":(\d+)/)?.[1];
console.log(`    sessions now=${sNow} (baseline was ${sessions0}) — unauthenticated initialize has no rate limit beyond MAX_SESSIONS=50`);
FIND('S2', 'low', 'Unauthenticated session exhaustion (max 50, 45min TTL)', 'loop POST /mcp initialize x50', 'all new sessions 503 until TTL expiry — trivial local DoS; no per-IP/rate limit', 'rate-limit or bind session creation to auth');

/* ================= PHASE X — final: likely-crash test ================= */
console.log('== X1 OPTIONS * (new URL("*") throws inside async handler -> unhandled rejection?) ==');
await check('OPTIONS *', 'OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', { fn: () => true });
await new Promise(r2 => setTimeout(r2, 700));
const stillAlive = await alive();
console.log(`    server alive after OPTIONS *: ${stillAlive}`);
if (!stillAlive) FIND('X1', 'critical', 'OPTIONS * crashes bridge via unhandled rejection', 'OPTIONS * HTTP/1.1 (Host: 127.0.0.1)', 'server process died — new URL("*") throws in async handler, no try/catch, no unhandledRejection handler', 'wrap routing in try/catch; return 400');

/* ================= summary ================= */
console.log('\n================ FINDINGS ================');
if (!findings.length) console.log('(none)');
for (const f of findings) {
  console.log(`\n[${f.sev.toUpperCase()}] ${f.id} ${f.title}\n  repro:    ${f.repro}\n  observed: ${f.observed}\n  expected: ${f.expected}`);
}
console.log(`\nTotal checks: ${checkN}; server alive at end: ${stillAlive}`);
