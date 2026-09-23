// adv-09 test server: network-capture fidelity endpoints on :8125
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 8125;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/iPA4YMqIHhPw4AAP//AwDtmK+FAAAAAElFTkSuQmCC', 'base64');
const FONTLIKE = Buffer.concat([Buffer.from('wOFF'), cryptoRandom(2048)]); // binary-ish
function cryptoRandom(n) { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost:8125'}`);
  const p = u.pathname;
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'access-control-allow-origin': '*', ...headers }); res.end(body); };
  const sendNoCors = (code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };

  if (p === '/nocors') return sendNoCors(200, 'no cors headers here', { 'content-type': 'text/plain' });

  if (p === '/' || p === '/index.html') {
    return send(200, `<!doctype html><html><head><meta charset=utf-8><title>adv09</title>
<link rel=stylesheet href=/style.css>
<script src=/script.js></script>
</head><body><img src=/img.png><img src="data:image/png;base64,${PNG.toString('base64')}"><div id=out></div></body></html>`, { 'content-type': 'text/html' });
  }
  if (p === '/style.css') return send(200, 'body{color:#123}', { 'content-type': 'text/css' });
  if (p === '/script.js') return send(200, 'window.__scriptLoaded=1;', { 'content-type': 'text/javascript' });
  if (p === '/img.png') return send(200, PNG, { 'content-type': 'image/png' });
  if (p === '/font.woff') return send(200, FONTLIKE, { 'content-type': 'font/woff' });
  if (p === '/json') return send(200, JSON.stringify({ ok: true, n: 42, s: 'héllo' }), { 'content-type': 'application/json' });
  if (p === '/final') return send(200, 'FINAL-' + Date.now(), { 'content-type': 'text/plain' });
  if (p === '/204') return send(204, null);
  if (p === '/301') return send(301, null, { location: '/final' });
  if (p === '/404') return send(404, 'nope', { 'content-type': 'text/plain' });
  if (p === '/500') return send(500, 'err', { 'content-type': 'text/plain' });

  // redirect chains: /r<codes>/<n> e.g. /r302/3 -> /r302/2 -> /r302/1 -> /final
  let m = p.match(/^\/r(30[1278])\/(\d+)$/);
  if (m) {
    const code = +m[1], n = +m[2];
    if (n <= 0) return send(200, 'FINAL', { 'content-type': 'text/plain' });
    return send(code, null, { location: `/r${code}/${n - 1}` });
  }
  if (p === '/chain-mixed') return send(301, null, { location: '/r302/2' });
  // cross-origin redirect: page on localhost -> 127.0.0.1 is a different origin
  if (p === '/xorigin') return send(302, null, { location: 'http://127.0.0.1:8125/final' });
  if (p === '/xorigin-back') return send(302, null, { location: 'http://localhost:8125/final' });

  if (p === '/slow') { const ms = Math.min(+u.searchParams.get('ms') || 2000, 20000); setTimeout(() => send(200, 'slow-ok', { 'content-type': 'text/plain' }), ms); return; }
  if (p === '/hang') { /* never respond */ return; }

  if (p === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    res.write('retry: 1000\n\n');
    let i = 0;
    const t = setInterval(() => { res.write(`data: tick${++i}\n\n`); if (i >= 30) { clearInterval(t); res.end(); } }, 500);
    req.on('close', () => clearInterval(t));
    return;
  }

  if (p === '/big') { const n = Math.min(+u.searchParams.get('n') || 1500000, 8000000); const chunk = Buffer.alloc(1024, 'x'); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); let left = n; (function w() { while (left > 0) { const c = Math.min(1024, left); left -= c; if (!res.write(chunk.subarray(0, c))) { res.once('drain', w); return; } } res.end(); })(); return; }

  if (p === '/download.bin') return send(200, cryptoRandom(4096), { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="blob.bin"' });

  if (p === '/cache') {
    const etag = '"v1"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
    return send(200, 'cacheable-' + Date.now(), { 'content-type': 'text/plain', etag, 'cache-control': 'max-age=60' });
  }
  if (p === '/nocache') return send(200, 'no-store', { 'content-type': 'text/plain', 'cache-control': 'no-store' });

  if (p === '/post-echo') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => send(200, JSON.stringify({ method: req.method, ct: req.headers['content-type'], len: b.length, body: b.slice(0, 500) }), { 'content-type': 'application/json' }));
    return;
  }

  if (p === '/sw.js') {
    return send(200, `self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.pathname==='/sw-served'){e.respondWith(new Response('SW-SYNTH',{headers:{'content-type':'text/plain'}}));}
  else if(u.pathname==='/sw-cached'){e.respondWith(caches.open('c1').then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(fr=>{c.put(e.request,fr.clone());return fr;}))));}
});`, { 'content-type': 'text/javascript' });
  }
  if (p === '/sw-served' || p === '/sw-cached') return send(200, 'NETWORK-' + p, { 'content-type': 'text/plain' });

  return send(404, 'unknown ' + p, { 'content-type': 'text/plain' });
});

const wss = new WebSocketServer({ server, path: '/ws-echo' });
wss.on('connection', (ws) => {
  ws.on('message', (m) => ws.send('echo:' + m));
  ws.send('hello-from-server');
});

server.listen(PORT, '0.0.0.0', () => console.log(`adv09 server on http://localhost:${PORT} (ws /ws-echo)`));
