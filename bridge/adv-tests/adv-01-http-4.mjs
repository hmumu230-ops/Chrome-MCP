// adv-01-http-4.mjs — follow-up probes: dup-Host ordering, half-close/RST crash
// candidates, chunk-size overflow, abs-form normalization, parser edge cases.
import net from 'node:net';
const HOST = '127.0.0.1', PORT = 7890;
const GH = 'Host: 127.0.0.1:7890';
const findings = [];
let checkN = 0;

function parseResponse(buf) {
  const s = buf.toString('latin1');
  const hi = s.indexOf('\r\n\r\n');
  if (hi === -1) return { headersDone: false, raw: s };
  const lines = s.slice(0, hi).split('\r\n');
  const m = lines[0].match(/^HTTP\/\d\.\d (\d{3})/);
  return { headersDone: true, status: m ? +m[1] : null, statusLine: lines[0], body: s.slice(hi + 4) };
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
    sock.on('connect', () => { if (opts.preWrite) opts.preWrite(sock); else sock.write(raw); });
    sock.on('data', (c) => {
      chunks.push(c);
      const p = parseResponse(Buffer.concat(chunks));
      if (p.headersDone) { clearTimeout(settleT); settleT = setTimeout(() => fin('ok-ish'), 350); }
    });
    sock.on('close', () => fin('eof'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(timeout, () => fin('timeout'));
  });
}
async function check(name, rawOrOpts, expect) {
  checkN++;
  const opts = typeof rawOrOpts === 'object' && !Buffer.isBuffer(rawOrOpts) && rawOrOpts.raw === undefined ? rawOrOpts : {};
  const raw = typeof rawOrOpts === 'string' ? rawOrOpts : rawOrOpts.raw;
  const r = await req(raw, opts);
  const obs = r.status != null
    ? `${r.status} (${r.tag}) body=${(r.body || '').slice(0, 70).replace(/\r?\n/g, '\\n')}`
    : `no HTTP response: ${r.tag}${r.sockErr ? ' ' + r.sockErr : ''}`;
  const ok = expect.status != null ? r.status === expect.status
    : expect.oneOf ? expect.oneOf.includes(r.status)
    : expect.fn ? !!expect.fn(r) : false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${checkN} ${name} -> ${obs}`);
  return r;
}
const alive = async () => (await req(`GET / HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`, { timeout: 3000 })).status === 200;
const ALIVE = async (w) => { const a = await alive(); console.log(`    ..alive after ${w}: ${a}${a ? '' : ' *** DOWN ***'}`); return a; };
const FIND = (id, sev, t, r, o, e) => findings.push({ id, sev, title: t, repro: r, observed: o, expected: e });

console.log('== V1 dup Host ordering (does parser first-win or join?) ==');
let r = await check('Host: evil.com THEN 127.0.0.1', 'GET / HTTP/1.1\r\nHost: evil.com\r\nHost: 127.0.0.1\r\n\r\n', { fn: () => true });
if (r.status === 200) FIND('V1-duphost', 'high', 'duplicate Host bypasses host check (last/first wins)', 'Host: evil.com + Host: 127.0.0.1', '200', '403');
r = await check('Host: 127.0.0.1 THEN evil.com', 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: evil.com\r\n\r\n', { fn: () => true });
console.log('    => server-side Host value seen as ' + (r.status === 200 ? 'FIRST wins' : 'reject/join'));
r = await check('hOsT mixed-case name', 'GET / HTTP/1.1\r\nhOsT: 127.0.0.1\r\n\r\n', { fn: () => true });
r = await check('Host tab-OWS value', 'GET / HTTP/1.1\r\nHost:\t127.0.0.1\t\r\n\r\n', { fn: () => true });
await ALIVE('dup-host');

console.log('== V2 half-close / RST crash candidates ==');
// POST /mcp CL:100 then immediate FIN — 'close' fires mid-readBody -> res.writeHead on dead socket
r = await check('POST /mcp CL:100 + FIN (no body)', {
  raw: `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`,
  preWrite: (s) => { s.write(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`); s.end(); },
}, { fn: () => true });
await new Promise(x => setTimeout(x, 700));
await ALIVE('half-close');
// same but hard RST
r = await check('POST /mcp CL:100 + RST', {
  preWrite: (s) => { s.write(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 100\r\n\r\n`); s.destroy(); },
  raw: '',
}, { fn: () => true });
await new Promise(x => setTimeout(x, 700));
await ALIVE('rst');
// FIN after headers on GET / (handler doesn't read body — but no body anyway)
r = await check('GET / + immediate FIN', {
  preWrite: (s) => { s.write(`GET / HTTP/1.1\r\n${GH}\r\n\r\n`); s.end(); },
  raw: '',
}, { fn: () => true });
await ALIVE('get-fin');

console.log('== V3 chunk/body parser edges ==');
await check('chunk-size overflow 16f', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\n`, { fn: (x) => x.status === 400 || x.status == null });
await ALIVE('chunk overflow');
await check('chunked LF-only endings', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: chunked\n\n0\n\n`, { fn: (x) => x.status === 400 || x.status == null });
await check('chunk with chunk-ext', `POST /mcp HTTP/1.1\r\n${GH}\r\nTransfer-Encoding: chunked\r\n\r\n2;ext=1\r\n{}\r\n0\r\n\r\n`, { fn: () => true });
await ALIVE('chunk-ext');
await check('valid JSON non-init, no session', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}`, { status: 404 });
await check('GET /?%0d%0aInject:x', `GET /%0d%0aInject:x HTTP/1.1\r\n${GH}\r\n\r\n`, { status: 404 });
await check('GET /mcp#frag', `GET /mcp%23frag HTTP/1.1\r\n${GH}\r\n\r\n`, { status: 404 });
await check('GET /mcp%3F', `GET /mcp%3F HTTP/1.1\r\n${GH}\r\n\r\n`, { status: 404 });

console.log('== V4 abs-form normalization & authority-form ==');
r = await check('GET http://127.0.0.1:7890/../x', `GET http://127.0.0.1:7890/../x HTTP/1.1\r\n${GH}\r\n\r\n`, { fn: () => true });
console.log(`    (abs-form /../x normalizes to '${r.status === 200 ? '/' : '?'}' -> status ${r.status})`);
await check('authority-form GET 127.0.0.1:7890', `GET 127.0.0.1:7890 HTTP/1.1\r\n${GH}\r\n\r\n`, { fn: () => true });
await check('OPTIONS * + session hdr', `OPTIONS * HTTP/1.1\r\n${GH}\r\nMcp-Session-Id: x\r\n\r\n`, { fn: () => true });
await check('header name X@Y', `GET / HTTP/1.1\r\n${GH}\r\nX@Y: v\r\n\r\n`, { fn: () => true });
await ALIVE('abs-form round');

console.log('== V5 keep-alive reuse after handler-level 4xx ==');
{
  const r2 = await new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ tag, raw: Buffer.concat(chunks).toString('latin1') }); };
    sock.on('connect', () => sock.write(
      `GET /nope HTTP/1.1\r\n${GH}\r\n\r\nGET / HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`));
    sock.on('data', c => chunks.push(c));
    sock.on('close', () => fin('eof'));
    sock.on('error', () => fin('err'));
    sock.setTimeout(5000, () => fin('timeout'));
  });
  const codes = (r2.raw.match(/HTTP\/1\.\d \d{3}/g) || []).map(s => s.split(' ')[1]);
  console.log(`    pipeline 404+GET on keep-alive -> responses=[${codes}] (handler 404 must not kill conn)`);
  if (!(codes[0] === '404' && codes[1] === '200')) FIND('V5-keepalive', 'low', 'connection closed after handler-level 404', 'GET /nope then GET / keep-alive', `responses=[${codes}]`, '[404,200]');
}
await ALIVE('final');

console.log('\n================ FINDINGS ================');
if (!findings.length) console.log('(none)');
for (const f of findings) console.log(`\n[${f.sev.toUpperCase()}] ${f.id} ${f.title}\n  repro: ${f.repro}\n  observed: ${f.observed}\n  expected: ${f.expected}`);
console.log(`\nchecks=${checkN} alive=${await alive()}`);
