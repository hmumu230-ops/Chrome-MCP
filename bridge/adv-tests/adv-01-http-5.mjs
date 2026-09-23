// adv-01-http-5.mjs — final verification on the unsupervised instance (pid varies).
// Re-verifies regression vector + FIN/RST abort paths + 10s body-timeout behavior.
import net from 'node:net';
const HOST = '127.0.0.1', PORT = 7890;
const GH = 'Host: 127.0.0.1:7890';
let checkN = 0;

function parseResponse(buf) {
  const s = buf.toString('latin1');
  const hi = s.indexOf('\r\n\r\n');
  if (hi === -1) return { headersDone: false, raw: s };
  const lines = s.slice(0, hi).split('\r\n');
  const m = lines[0].match(/^HTTP\/\d\.\d (\d{3})/);
  return { headersDone: true, status: m ? +m[1] : null, statusLine: lines[0], body: s.slice(hi + 4) };
}
function req(raw, timeout = 5000) {
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
      if (p.headersDone) { clearTimeout(settleT); settleT = setTimeout(() => fin('ok-ish'), 350); }
    });
    sock.on('close', () => fin('eof'));
    sock.on('error', (e) => fin('err', { sockErr: e.code || e.message }));
    sock.setTimeout(timeout, () => fin('timeout'));
  });
}
const show = async (name, p) => {
  checkN++;
  const r = await p;
  const obs = r.status != null ? `${r.status} (${r.tag}) body=${(r.body || '').slice(0, 70).replace(/\r?\n/g, '\\n')}`
    : `no response: ${r.tag}${r.sockErr ? ' ' + r.sockErr : ''}`;
  console.log(`#${checkN} ${name} -> ${obs}`);
  return r;
};
const alive = async () => (await req(`GET / HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`, 3000)).status === 200;
const ALIVE = async (w) => { const a = await alive(); console.log(`   ..alive after ${w}: ${a}${a ? '' : ' *** DOWN ***'}`); return a; };

// custom: send bytes, then action (fin / rst / nothing), collect to timeout
function custom(name, bytes, action, timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag, extra) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve({ tag, ms: Date.now() - t0, ...parseResponse(Buffer.concat(chunks)), ...extra }); };
    s.on('connect', () => { s.write(bytes); if (action === 'fin') s.end(); else if (action === 'rst') s.destroy(); });
    s.on('data', c => chunks.push(c));
    s.on('close', () => fin('eof'));
    s.on('error', e => fin('err', { sockErr: e.code || e.message }));
    s.setTimeout(timeout, () => fin('timeout'));
  }).then(r => show(name, Promise.resolve(r)));
}

console.log('== re-verify regression on this instance ==');
await show('GET http://:80/ #1', req(`GET http://:80/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`));
await ALIVE('v1');
await show('GET http://:80/ #2', req(`GET http://:80/ HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`));
await ALIVE('v2');
await show('GET http:// (bare)', req(`GET http:// HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`));
await ALIVE('bare');
await show('missing Host', req('GET / HTTP/1.1\r\n\r\n'));
await ALIVE('nohost');

console.log('== FIN/RST abort paths (fixed probe) ==');
await custom('POST /mcp CL:100 + FIN', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`, 'fin');
await ALIVE('fin');
await custom('POST /mcp CL:100 + RST', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 100\r\n\r\n`, 'rst');
await ALIVE('rst');
await custom('POST /mcp CL:100, 10 bytes then FIN', `POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 100\r\n\r\nxxxxxxxxxx`, 'fin');
await ALIVE('partial+fin');

console.log('== 10s body-read timer (drip then stop) ==');
{
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const s = net.createConnection(PORT, HOST);
    const chunks = []; let done = false;
    const fin = (tag, x) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve({ tag, ms: Date.now() - t0, ...parseResponse(Buffer.concat(chunks)), ...x }); };
    s.on('connect', () => {
      s.write(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 500\r\n\r\n` + 'x'.repeat(50));
      // drip a little then stop entirely
      let n = 0; const iv = setInterval(() => { if (done || s.destroyed || ++n > 3) return clearInterval(iv); s.write('y'.repeat(10)); }, 800);
    });
    s.on('data', c => chunks.push(c));
    s.on('close', () => fin('eof'));
    s.on('error', e => fin('err', { sockErr: e.code || e.message }));
    s.setTimeout(15000, () => fin('timeout'));
  });
  console.log(`   drip-stop -> status=${r.status ?? 'none'} tag=${r.tag} ms=${r.ms}${r.sockErr ? ' err=' + r.sockErr : ''} body=${(r.body || '').slice(0, 60)}`);
  // expected: server fires its 10s readBody timer -> 400 or socket close ~10s
}
await ALIVE('drip-stop');

console.log('== smuggling re-verify ==');
await show('TE+CL again', req(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`));
await show('dup CL conflict again', req(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Length: 2\r\nContent-Length: 5\r\n\r\n{}`));
await ALIVE('smuggle re-verify');

console.log(`\ndone checks=${checkN} alive=${await alive()}`);
