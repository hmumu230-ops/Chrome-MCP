// adv-01-http-3.mjs — HTTP transport REGRESSION + new fuzz round.
// Raw TCP for byte-level control. Every attack is followed by a liveness probe.
// Run from Windows node.exe:  node adv-tests\adv-01-http-3.mjs
import net from 'node:net';

const HOST = '127.0.0.1', PORT = 7890;
const GH = 'Host: 127.0.0.1:7890';
let checkN = 0;
const findings = [];

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
  return { headersDone: true, status: m ? +m[1] : null, statusLine: lines[0], headers, body, complete };
}

function req(raw, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false, settleT = null;
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
      clearTimeout(settleT);
      settleT = setTimeout(() => fin('ok-ish'), 400);
    });
    sock.on('close', () => fin('eof'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(timeout, () => fin('timeout'));
  });
}

const B = (method, target, headers = [], body = '') =>
  `${method} ${target} HTTP/1.1\r\n${GH}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}Connection: close\r\n\r\n${body}`;

async function check(name, raw, expect, note = '') {
  checkN++;
  const r = await req(raw, expect._opts || {});
  let ok = false, obs;
  if (r.status != null) obs = `${r.status} (${r.tag}) body=${(r.body || '').slice(0, 80).replace(/\r?\n/g, '\\n')}`;
  else obs = `no HTTP response: ${r.tag}${r.sockErr ? ' ' + r.sockErr : ''} bytes=${(r.raw || '').length}`;
  if (expect.status != null) ok = r.status === expect.status;
  else if (expect.oneOf) ok = expect.oneOf.includes(r.status);
  else if (expect.fn) ok = !!expect.fn(r);
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${checkN} ${name} -> ${obs}${note ? '   [' + note + ']' : ''}`);
  return r;
}

const alive = async () => (await req(B('GET', '/'), { timeout: 3000 })).status === 200;
const ALIVE = async (where) => {
  const a = await alive();
  console.log(`    ..alive after ${where}: ${a}${a ? '' : '   *** BRIDGE DOWN ***'}`);
  return a;
};
const FIND = (id, sev, title, repro, observed, expected) =>
  findings.push({ id, sev, title, repro, observed, expected });

/* ============ R: REGRESSION — malformed absolute-form / request line ============ */
console.log('== R absolute-form regression (was CRITICAL crash) ==');
for (const [name, raw] of [
  ['GET http://:80/  (orig crash)', `GET http://:80/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET http://      (bare scheme)', `GET http:// HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET foo://bar    (foreign scheme)', `GET foo://bar HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET http://a:bad/ (bad port)', `GET http://a:bad/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET http://%zz/   (bad pct)', `GET http://%zz/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET http://[::1   (unclosed ipv6)', `GET http://[::1 HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['OPTIONS *         (asterisk-form)', `OPTIONS * HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['GET *             (asterisk GET)', `GET * HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`],
  ['POST http://evil.com/mcp (abs-form foreign host)', `POST http://evil.com/mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2\r\n\r\n{}`],
]) {
  const r = await check(name, raw, { fn: () => true });
  await ALIVE(name);
  if (r.status != null && (r.status < 400 || r.status > 499) && !(name.includes('foo://') || name.includes('abs-form')))
    FIND('R-' + name, 'medium', 'malformed request-target not 4xx', name, `status ${r.status}`, '4xx');
}
// verify the original crash vector a 2nd time
await check('GET http://:80/ REPEAT', `GET http://:80/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`, { fn: (r) => r.status === 400 });
await ALIVE('repeat crash-vector');

console.log('== R2 request-line oddities ==');
await check('missing Host (HTTP/1.1)', 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n', { oneOf: [400, 403] });
await ALIVE('missing Host');
await check('HTTP/0.9-style (no version)', 'GET /\r\n\r\n', { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('http/0.9');
await check('HTTP/1.0 no Host', 'GET / HTTP/1.0\r\n\r\n', { status: 403 });
await check('HTTP/9.9 version', `GET / HTTP/9.9\r\n${GH}\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('HTTP/9.9');
await check('lowercase method "get"', `get / HTTP/1.1\r\n${GH}\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });
await check('HTTP/2 preface PRI *', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('PRI preface');
await check('LF-only line endings', `GET / HTTP/1.1\n${GH}\n\n`, { fn: (r) => r.status === 400 || r.status == null || r.status === 200 });
await ALIVE('LF-only');
await check('space in request-target', `GET /a b HTTP/1.1\r\n${GH}\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });

/* ============ F1: oversized headers ============ */
console.log('== F1 oversized headers (Node maxHeaderSize=16384) ==');
await check('single header ~20KB', `GET / HTTP/1.1\r\n${GH}\r\nX-Big: ${'A'.repeat(20000)}\r\n\r\n`, { status: 431 });
await ALIVE('20KB header');
await check('~15.9KB header (under limit)', `GET / HTTP/1.1\r\n${GH}\r\nX-Big: ${'A'.repeat(15800)}\r\nConnection: close\r\n\r\n`, { status: 200 });
await check('~20KB via many headers', `GET / HTTP/1.1\r\n${GH}\r\n` + Array.from({ length: 500 }, (_, i) => `X-H${i}: ${'B'.repeat(28)}`).join('\r\n') + '\r\n\r\n', { status: 431 });
await ALIVE('many-headers');
await check('20KB request-target', `GET /${'p'.repeat(20000)} HTTP/1.1\r\n${GH}\r\n\r\n`, { status: 431 });
await ALIVE('20KB target');
await check('8KB request-target (under limit)', `GET /${'p'.repeat(8000)} HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`, { status: 404 });

/* ============ F2: smuggling — TE/CL conflicts ============ */
console.log('== F2 request-smuggling vectors ==');
for (const [name, raw] of [
  ['TE:chunked + CL:4', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
  ['CL + TE:Chunked (case)', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 4\r\nTransfer-Encoding: Chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
  ['CL + TE:chunked reversed order', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
  ['TE: identity + CL', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: identity\r\nContent-Length: 2\r\n\r\n{}`],
  ['TE: gzip, chunked', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
  ['TE: xchunked', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: xchunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
  ['TE whitespace-before-colon', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding : chunked\r\n\r\n0\r\n\r\n`],
  ['CL tab-before-colon', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length\t: 2\r\n\r\n{}`],
  ['dup CL same value', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`],
  ['dup CL CONFLICT 2 vs 5', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2\r\nContent-Length: 5\r\n\r\n{}`],
  ['CL comma list "2, 2"', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2, 2\r\n\r\n{}`],
  ['CL comma CONFLICT "2, 5"', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2, 5\r\n\r\n{}`],
  ['CL +5', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: +5\r\n\r\n{}`],
  ['CL 0x10', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 0x10\r\n\r\n{}`],
  ['CL leading zeros 002', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 002\r\n\r\n{}`],
  ['dup Host good then evil', `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: evil.com\r\n\r\n`],
]) {
  const r = await check(name, raw, { fn: () => true });
  const a = await ALIVE(name);
  if (!a) FIND('F2-' + name, 'critical', 'request killed bridge', name, 'no liveness', 'alive');
}

/* ============ F3: method fuzz ============ */
console.log('== F3 method fuzz ==');
for (const m of ['TRACE', 'CONNECT', 'OPTIONS', 'PATCH', 'PROPFIND', 'BREW', 'MKCOL', 'LINK']) {
  const raw = m === 'CONNECT'
    ? `CONNECT 127.0.0.1:7890 HTTP/1.1\r\n${GH}\r\n\r\n`   // authority-form
    : B(m, '/mcp', m === 'PATCH' || m === 'PROPFIND' ? ['Content-Length: 0'] : []);
  const r = await check(`${m} ${m === 'CONNECT' ? '127.0.0.1:7890' : '/mcp'}`, raw, { fn: (x) => x.status !== 200 && x.status !== 101 });
  await ALIVE(m);
  if (r.status === 200) FIND('F3-' + m, 'high', `method ${m} unexpectedly honored`, raw.split('\r\n')[0], '200', '405/404/close');
}
// TRACE echo check on /
const tr = await req(B('TRACE', '/', ['X-Echo: secret-header']));
if (tr.body && tr.body.includes('secret-header')) FIND('F3-TRACE-echo', 'medium', 'TRACE reflects headers (XST)', 'TRACE /', 'headers echoed', 'no reflection');
console.log(`    TRACE / -> ${tr.status ?? tr.tag}, reflects-headers=${!!(tr.body && tr.body.includes('secret-header'))}`);

/* ============ F4: path traversal / weird targets ============ */
console.log('== F4 path traversal & weird targets ==');
for (const t of [
  '/../..//etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/mcp/../../index.js',
  '//etc/passwd', '/..\\..\\windows\\win.ini', '/....//....//etc', '/mcp%2f..%2f',
  '/%00', '/%2e%2e%2f', 'http://127.0.0.1:7890/mcp', 'http://127.0.0.1/mcp',
]) {
  const r = await check(`GET ${t.slice(0, 40)}`, B('GET', t), { fn: () => true });
  if (r.status === 200 && t !== '/' && !t.startsWith('http://127.0.0.1'))
    FIND('F4-' + t, 'low', 'weird path returned 200', `GET ${t}`, '200', '404');
}
await ALIVE('traversal batch');
// file-content leak check: does any traversal body contain real file data?
const tv = await req(B('GET', '/../../bridge/index.js'));
if (tv.body && /createServer|require\(/.test(tv.body)) FIND('F4-traversal-leak', 'critical', 'path traversal reads files', 'GET /../../bridge/index.js', 'source returned', '404');
console.log(`    traversal file-read check: status=${tv.status} leak=${!!(tv.body && /createServer/.test(tv.body))}`);

/* ============ F5: null bytes ============ */
console.log('== F5 null bytes ==');
await check('NUL in request-target', `GET /a\x00b HTTP/1.1\r\n${GH}\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('NUL target');
await check('NUL in header value', `GET / HTTP/1.1\r\n${GH}\r\nX-T: a\x00b\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('NUL hdr value');
await check('NUL in Host value', 'GET / HTTP/1.1\r\nHost: 127.0.0.1\x00.evil.com\r\n\r\n', { fn: (r) => r.status === 400 || r.status == null });
await ALIVE('NUL host');
await check('NUL in header name', `GET / HTTP/1.1\r\n${GH}\r\nX\x00T: v\r\n\r\n`, { fn: (r) => r.status === 400 || r.status == null });
await check('encoded %00 in target', B('GET', '/%00%00'), { status: 404 });

/* ============ F6: slow-loris x3 (hold 5s, release) ============ */
console.log('== F6 slow-loris x3 (5s hold) ==');
{
  const socks = [];
  for (let i = 0; i < 3; i++) {
    const s = net.createConnection(PORT, HOST);
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\n${GH}\r\nX-Loris: ${i}\r\n`)); // no terminating CRLF
    s.on('error', () => {});
    socks.push(s);
  }
  await new Promise(r => setTimeout(r, 2500));
  const midAlive = await alive();
  console.log(`    mid-loris liveness (2.5s in): ${midAlive}`);
  if (!midAlive) FIND('F6-mid', 'high', '3 slow-loris conns block legit traffic', '3 partial requests', 'GET / failed during hold', 'server responsive');
  await new Promise(r => setTimeout(r, 2500));
  for (const s of socks) { try { s.destroy(); } catch {} }
  await ALIVE('loris release (5s)');
}

/* ============ F7: request pipelining ============ */
console.log('== F7 pipelining ==');
{
  const r = await new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ tag, raw: Buffer.concat(chunks).toString('latin1') }); };
    sock.on('connect', () => sock.write(
      `GET / HTTP/1.1\r\n${GH}\r\n\r\nGET / HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`));
    sock.on('data', c => chunks.push(c));
    sock.on('close', () => fin('eof'));
    sock.on('error', () => fin('err'));
    sock.setTimeout(5000, () => fin('timeout'));
  });
  const codes = (r.raw.match(/HTTP\/1\.\d \d{3}/g) || []).map(s => s.split(' ')[1]);
  checkN++;
  console.log(`${codes.length === 2 && codes[0] === '200' && codes[1] === '200' ? 'PASS' : 'FAIL'}  #${checkN} pipeline 2xGET -> responses=[${codes}] tag=${r.tag}`);
  if (codes.length !== 2) FIND('F7-pipe', 'low', 'pipelined requests mishandled', 'GET / + GET / in one write', `responses=[${codes}]`, 'two 200s');
}
{
  // good request pipelined with garbage second request
  const r = await new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ tag, raw: Buffer.concat(chunks).toString('latin1') }); };
    sock.on('connect', () => sock.write(
      `GET / HTTP/1.1\r\n${GH}\r\n\r\nGARBAGE!!!\r\n\r\n`));
    sock.on('data', c => chunks.push(c));
    sock.on('close', () => fin('eof'));
    sock.on('error', () => fin('err'));
    sock.setTimeout(5000, () => fin('timeout'));
  });
  const codes = (r.raw.match(/HTTP\/1\.\d \d{3}/g) || []).map(s => s.split(' ')[1]);
  console.log(`    pipeline GET+garbage -> responses=[${codes}] tag=${r.tag}`);
}
await ALIVE('pipelining');

/* ============ F8: Expect / upgrade edge cases ============ */
console.log('== F8 misc protocol edges ==');
await check('Expect: 100-continue then full body', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n{}`, { fn: () => true });
await check('h2c upgrade attempt', `GET / HTTP/1.1\r\n${GH}\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n`, { fn: (r) => r.status == null || r.status === 400 || r.status === 426 || r.status === 200 });
await ALIVE('h2c');
await check('WS upgrade malformed abs target', `GET http://:80/ HTTP/1.1\r\n${GH}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`, { fn: (r) => r.status !== 101 });
await ALIVE('upgrade malformed');
await check('GET / with smuggled req in body (CL)', `GET / HTTP/1.1\r\n${GH}\r\nContent-Length: 45\r\n\r\nGET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, { fn: () => true });
await ALIVE('GET-body-smuggle');

/* ============ H: Host header attacks ============ */
console.log('== H host header attacks ==');
const H = (hostVal) => `GET / HTTP/1.1\r\nHost: ${hostVal}\r\nConnection: close\r\n\r\n`;
const hostCases = [
  ['evil.com', 403], ['127.0.0.1:1', 200], ['127.0.0.1:evil', 200],
  ['localhost.evil.com', 403], ['127.0.0.1.nip.io', 403], ['127.0.0.1.evil.com', 403],
  ['0x7f000001', 403], ['2130706433', 403], ['0177.0.0.1', 403],
  ['[::ffff:127.0.0.1]', 403], ['::1', 403], ['[::1]', 200], ['[::1]:7890', 200], ['[::1]:1', 200],
  ['localhost.', 403], ['LOCALHOST', 403], ['LocalHost', 403],
  ['127.0.0.1.', 403], ['127.0.0.1:7890:extra', 200],
  ['127.0.0.1#@evil.com', 403], ['127.0.0.1%2f.evil.com', 403],
  ['localhost:0', 200], [' 127.0.0.1', 200], ['127.0.0.1 ', 200],
];
for (const [h, exp] of hostCases) {
  const r = await check(`Host: ${h}`, H(h), { fn: () => true });
  if (r.status !== exp)
    FIND('H-' + h, r.status === 200 ? 'high' : 'low', `Host: ${h} -> ${r.status}`, `Host: ${h}`, `status ${r.status}`, `expected ${exp}`);
}
// DNS-rebind style origins with good Host
console.log('== H2 origin/rebind ==');
for (const [o, exp] of [
  ['http://evil.com', 403], ['http://127.0.0.1.nip.io', 403], ['http://0x7f000001', 403],
  ['http://[::ffff:127.0.0.1]', 403], ['https://127.0.0.1:7890', 200], ['http://127.0.0.1:', 200],
  ['null', 403],
]) {
  await check(`Origin: ${o}`, B('GET', '/', [`Origin: ${o}`]), { status: exp });
}
await ALIVE('host batch');

/* ============ summary ============ */
console.log('\n================ FINDINGS ================');
if (!findings.length) console.log('(none)');
for (const f of findings)
  console.log(`\n[${f.sev.toUpperCase()}] ${f.id} ${f.title}\n  repro:    ${f.repro}\n  observed: ${f.observed}\n  expected: ${f.expected}`);
const finalAlive = await alive();
console.log(`\nTotal checks: ${checkN}; bridge alive at end: ${finalAlive}`);
