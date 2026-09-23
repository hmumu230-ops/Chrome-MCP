// finprobe — why did GET / + immediate FIN time out? verbose event trace.
import net from 'node:net';
const HOST = '127.0.0.1', PORT = 7890;
const GH = 'Host: 127.0.0.1:7890';

function probe(name, writeFn, waitMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection(PORT, HOST);
    const log = [];
    const ev = (e, d) => { log.push(`[${String(Date.now() - t0).padStart(4)}ms] ${e}${d ? ' ' + d : ''}`); };
    s.on('connect', () => { ev('connect'); writeFn(s); });
    s.on('data', (c) => ev('data', JSON.stringify(c.toString('latin1').slice(0, 120))));
    s.on('end', () => ev('end'));
    s.on('finish', () => ev('finish'));
    s.on('close', (hadErr) => { ev('close', 'hadErr=' + hadErr); done(); });
    s.on('error', (e) => ev('error', e.code || e.message));
    s.setTimeout(waitMs, () => { ev('timeout'); s.destroy(); });
    function done() {
      console.log(`--- ${name}`);
      for (const l of log) console.log('   ' + l);
      resolve();
    }
  });
}

// 1) GET / then FIN after 50ms (response should already be in flight)
await probe('GET / , FIN after 50ms', (s) => {
  s.write(`GET / HTTP/1.1\r\n${GH}\r\n\r\n`);
  setTimeout(() => s.end(), 50);
});
// 2) GET / then immediate FIN same tick
await probe('GET / , immediate FIN', (s) => { s.write(`GET / HTTP/1.1\r\n${GH}\r\n\r\n`); s.end(); });
// 3) GET / , keep open 2s for baseline sanity
await probe('GET / , no FIN (baseline)', (s) => { s.write(`GET / HTTP/1.1\r\n${GH}\r\nConnection: close\r\n\r\n`); });
// 4) POST /mcp CL:100 headers only, FIN — expect parser abort
await probe('POST /mcp CL:100 headers + FIN', (s) => {
  s.write(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`);
  s.end();
});
// 5) same but FIN after 300ms
await probe('POST /mcp CL:100 headers, FIN +300ms', (s) => {
  s.write(`POST /mcp HTTP/1.1\r\n${GH}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n`);
  setTimeout(() => s.end(), 300);
});
console.log('done');
