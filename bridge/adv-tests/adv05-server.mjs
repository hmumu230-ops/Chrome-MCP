// tiny static server for adv05 test pages on :8123
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'adv05-pages');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(dir, p === '/' ? 'grid.html' : p);
  if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(d);
  });
}).listen(8123, '127.0.0.1', () => console.log('adv05 server on 8123'));
