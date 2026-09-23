// adv14 static file server — port 8128
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let f = url.pathname === '/' ? '/index.html' : url.pathname;
  const p = path.join(root, path.normalize(f));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end('nope'); }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404 ' + f); }
    res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8128, '0.0.0.0', () => console.log('adv14 server on :8128'));
