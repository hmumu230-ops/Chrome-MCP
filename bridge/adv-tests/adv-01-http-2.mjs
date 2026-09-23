// adv-01-http-2.mjs — tail of HTTP transport tests: chunked POST, DELETE cleanup,
// then absolute-form request-targets that make `new URL()` throw (crash candidates).
import net from 'node:net';
const PORT = 7890, HOST = '127.0.0.1';

function parse(buf) {
  const s = buf.toString('latin1');
  const hi = s.indexOf('\r\n\r\n');
  if (hi === -1) return { raw: s };
  const lines = s.slice(0, hi).split('\r\n');
  const m = lines[0].match(/^HTTP\/\d\.\d (\d{3})/);
  return { status: m ? +m[1] : null, statusLine: lines[0], body: s.slice(hi + 4).slice(0, 120) };
}
function req(raw, timeout = 5000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag, extra) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ tag, ...parse(Buffer.concat(chunks)), ...extra }); };
    sock.on('connect', () => sock.write(raw));
    sock.on('data', (c) => { chunks.push(c); const p = parse(Buffer.concat(chunks)); if (p.status === 101) fin('ok'); });
    sock.on('close', () => fin('eof'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(timeout, () => fin('timeout'));
  });
}
const alive = async () => (await req('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', 3000)).status === 200;

// 1. chunked POST with valid init body — should work (CL absent => len 0, reads chunks)
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv', version: '0' } } });
const chunked = `POST /mcp HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${INIT.length.toString(16)}\r\n${INIT}\r\n0\r\n\r\n`;
let r = await req(chunked);
console.log('chunked init ->', r.status, (r.body || '').slice(0, 80));

// 2. fresh session via fetch, then DELETE it, then reuse -> 404
const res = await fetch(`http://${HOST}:${PORT}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT });
const sid = res.headers.get('mcp-session-id');
console.log('init ->', res.status, 'sid', sid);
r = await req(`DELETE /mcp HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nMcp-Session-Id: ${sid}\r\nConnection: close\r\n\r\n`);
console.log('DELETE session ->', r.status);
r = await req(`GET /mcp HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nMcp-Session-Id: ${sid}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n`);
console.log('reuse after DELETE ->', r.status, (r.body || '').slice(0, 60));

// 3. crash candidates — absolute-form request targets that throw in `new URL`.
// Each followed by a liveness probe. LAST ONES, since a crash is unrecoverable.
const cands = [
  'GET http://:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
  'GET http://a:bad/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
  'GET http://%zz/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
  'OPTIONS http://* HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
];
for (const c of cands) {
  const firstLine = c.split('\r\n')[0];
  r = await req(c);
  console.log(`${firstLine} -> status=${r.status ?? 'none'} tag=${r.tag}${r.sockErr ? ' ' + r.sockErr : ''}`);
  await new Promise(x => setTimeout(x, 600));
  const a = await alive();
  console.log(`    server alive: ${a}`);
  if (!a) { console.log('    *** BRIDGE CRASHED by this request-target ***'); break; }
}
console.log('done');
