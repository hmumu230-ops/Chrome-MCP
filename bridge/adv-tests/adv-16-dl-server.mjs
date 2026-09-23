// adv-16-dl-server.mjs — test HTTP server on 127.0.0.1:8127 for download_file adversarial tests.
// Routes under /file/* serve controlled payloads; /admin/die kills the process mid-stream.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2]) || 8127;
const reqLog = [];

// Deterministic 50MB binary: byte[i] = (i*31+7) & 0xff
const BIG_SIZE = 50 * 1024 * 1024;
const bigBuf = Buffer.alloc(BIG_SIZE);
for (let i = 0; i < BIG_SIZE; i++) bigBuf[i] = (i * 31 + 7) & 0xff;
const bigHash = crypto.createHash('sha256').update(bigBuf).digest('hex');

const TESTFILE = Buffer.from('hello from mcp download test\nline2\n');
const testfileHash = crypto.createHash('sha256').update(TESTFILE).digest('hex');
const EXE = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096)]); // fake PE
const BAT = Buffer.from('@echo off\r\necho mcp test bat\r\n');
const HTML = Buffer.from('<!doctype html><html><body><h1>not really a txt</h1><script>alert(1)</script></body></html>');

const sockets = new Set();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  reqLog.push(req.method + ' ' + req.url);
  const p = u.pathname;

  if (p === '/admin/die') {
    res.end('bye');
    setTimeout(() => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 800);
    }, 200);
    return;
  }
  if (p === '/admin/log') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ reqLog, bigHash, testfileHash }));
    return;
  }
  if (p === '/file/big.sha256') {
    res.end(bigHash + '  big.bin\n' + testfileHash + '  testfile.txt\n');
    return;
  }

  switch (p) {
    case '/file/testfile.txt':
      res.setHeader('content-type', 'text/plain'); res.end(TESTFILE); return;
    case '/file/big.bin':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', BIG_SIZE);
      res.end(bigBuf); return;
    case '/file/cd-backslash':
      // Content-Disposition filename with ..\ traversal (raw backslash in quoted string)
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="..\\mcp-test-cd-evil.bat"');
      res.end(BAT); return;
    case '/file/cd-rfc5987':
      // RFC 5987 encoded filename: ../mcp-test-cd-evil2.bat
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', "attachment; filename*=UTF-8''%2e%2e%2fmcp-test-cd-evil2.bat");
      res.end(BAT); return;
    case '/file/cd-abs':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="C:\\mcp-test-cd-abs.bat"');
      res.end(BAT); return;
    case '/file/cd-subdir':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="mcp-test-cdsub/nested.txt"');
      res.end(TESTFILE); return;
    case '/file/zero.bin':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', '0'); res.end(); return;
    case '/file/confuse.txt':
      // content-type confusion: HTML body served as text/plain
      res.setHeader('content-type', 'text/plain'); res.end(HTML); return;
    case '/file/confuse2.bin':
      // HTML body as octet-stream with .bin url
      res.setHeader('content-type', 'application/octet-stream'); res.end(HTML); return;
    case '/file/fake.exe':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="mcp-test-fake.exe"');
      res.end(EXE); return;
    case '/file/fake.bat':
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="mcp-test-fake.bat"');
      res.end(BAT); return;
    case '/file/redir-file':
      res.writeHead(302, { location: 'file:///C:/Windows/win.ini' }); res.end(); return;
    case '/file/redir-data':
      res.writeHead(302, { location: 'data:text/plain;base64,bWNwLXRlc3QtcmVkaXItZGF0YQ==' }); res.end(); return;
    case '/file/redir-js':
      res.writeHead(302, { location: 'javascript:alert(1)' }); res.end(); return;
    case '/file/huge': {
      // 200MB streamed slowly (~10MB/s) for interrupt testing
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', 200 * 1024 * 1024);
      const chunk = Buffer.alloc(1024 * 1024, 0xab);
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= 200) { clearInterval(timer); res.end(); return; }
        for (let i = 0; i < 10 && sent < 200; i++, sent++) res.write(chunk);
      }, 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    case '/file/nolength':
      // no content-length — chunked; closes when done
      res.setHeader('content-type', 'application/octet-stream');
      res.write(TESTFILE); res.end(); return;
    default:
      res.writeHead(404); res.end('nope'); return;
  }
});

server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
server.listen(PORT, '127.0.0.1', () => console.log('dl-server on 127.0.0.1:' + PORT + ' bigSha=' + bigHash));
setTimeout(() => { console.log('auto-exit'); process.exit(0); }, 15 * 60 * 1000);
