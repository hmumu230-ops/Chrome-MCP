// Echo server for header/cookie tests on 127.0.0.1:8127. Logs request line + headers.
import http from 'node:http';
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const rec = { method: req.method, url: req.url, headers: req.headers, body: body.slice(0, 500) };
    // redact cookie values in the log line (keep names)
    const cookieHdr = req.headers.cookie || '';
    rec.cookieNames = cookieHdr.split(';').map(p => p.trim().split('=')[0]).filter(Boolean);
    delete rec.headers.cookie;
    console.log('REQ', JSON.stringify(rec));
    res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
    res.end(JSON.stringify({ ok: true, cookieNames: rec.cookieNames, sawCookie: !!cookieHdr, headers: req.headers }));
  });
});
srv.listen(8199, '127.0.0.1', () => console.log('echo on 8199'));
