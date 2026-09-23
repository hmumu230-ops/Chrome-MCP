// adv-08 round 2: probes blocked by screenshot surface error, via evaluate_script.
import fs from 'node:fs';

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

const np = await call('new_page', { url: 'https://example.com' });
const npTxt = text(np);
const pageId = JSON.parse(npTxt.slice(npTxt.indexOf('{'))).pageId;
console.log('pageId=', pageId);

const ev = fp => ({ pageId, function: '() => "PWNED"', filePath: fp });
const probe = async (label, tool, args, checkPaths) => {
  const r = await call(tool, args);
  const t = text(r).split('\n').slice(0, 2).join(' | ');
  const checks = checkPaths.map(p => `${p} => ${exists(p)}`).join(' ; ');
  console.log(`[${label}]\n  resp: ${t.slice(0, 200)}\n  disk: ${checks}`);
};

// retry screenshot once after bringToFront
await call('select_page', { pageId, bringToFront: true });
await new Promise(r => setTimeout(r, 800));
await probe('screenshot after bringToFront', 'take_screenshot', { pageId, filePath: `${ADV}/shot.png` }, [`${ADV}/shot.png`]);

// relative traversal (bridge cwd = D:\Tool\chrome-mcp\bridge)
await probe('rel traversal -> D:\\Windows\\Temp', 'evaluate_script', ev('../../../../Windows/Temp/mcp-pwn.txt'), ['D:/Windows/Temp/mcp-pwn.txt']);
// deeper traversal attempt toward C: is impossible via .. on D: cwd; try absolute-with-drive-relative trick
await probe('bare relative (cwd leak)', 'evaluate_script', ev('adv08-cwd-marker.txt'), [`${BRIDGE}/adv08-cwd-marker.txt`]);
// System32 — permission probe
await probe('C:/Windows/System32', 'evaluate_script', ev('C:/Windows/System32/mcp-pwn.txt'), ['C:/Windows/System32/mcp-pwn.txt']);
// UNC admin share
await probe('UNC c$ share', 'evaluate_script', ev('\\\\127.0.0.1\\c$\\Temp\\unc-pwn.txt'), ['\\\\127.0.0.1\\c$\\Temp\\unc-pwn.txt']);
// UNC loopback via localhost? also try file:// style path with forward UNC
await probe('UNC //127.0.0.1/c$/Temp fwd', 'evaluate_script', ev('//127.0.0.1/c$/Temp/unc-pwn2.txt'), ['\\\\127.0.0.1\\c$\\Temp\\unc-pwn2.txt']);
// null byte
await probe('null byte', 'evaluate_script', ev(`${ADV}/nb${String.fromCharCode(0)}.txt`), [`${ADV}/nb.txt`, `${ADV}/nb`]);
// trailing-dot / trailing-space tricks
await probe('trailing dot file.', 'evaluate_script', ev(`${ADV}/dotfile.`), [`${ADV}/dotfile.`, `${ADV}/dotfile`]);
await probe('trailing space', 'evaluate_script', ev(`${ADV}/sp.txt `), [`${ADV}/sp.txt `, `${ADV}/sp.txt`]);
// ADS alternate data stream
await probe('ADS host.txt:evil', 'evaluate_script', ev(`${ADV}/host.txt:evilstream`), [`${ADV}/host.txt`]);
// long paths
await probe('280-char segment', 'evaluate_script', ev(`${ADV}/` + 'a'.repeat(280) + '.txt'), []);
await probe('deep nested >260', 'evaluate_script', ev(`${ADV}/` + 'deep/'.repeat(60) + 'f.txt'), [`${ADV}/deep`]);
await probe('500-char filename rel', 'evaluate_script', ev('a'.repeat(500)), [`${BRIDGE}/` + 'a'.repeat(500)]);
// type confusion
await probe('empty filePath', 'evaluate_script', ev(''), []);
await probe('numeric filePath', 'evaluate_script', ev(123), []);
await probe('object filePath', 'evaluate_script', ev({ x: 1 }), []);
await probe('array filePath', 'evaluate_script', ev(['a', 'b']), []);
await probe('boolean filePath', 'evaluate_script', ev(true), []);
// perf trace writer
await call('performance_start_trace', { pageId, reload: false });
await new Promise(r => setTimeout(r, 1200));
await probe('performance_stop_trace filePath', 'performance_stop_trace', { pageId, filePath: `${ADV}/trace.json` }, [`${ADV}/trace.json`]);
await probe('performance_stop_trace traversal', 'performance_stop_trace', { pageId, filePath: 'C:/Windows/Temp/mcp-trace-pwn.json' }, ['C:/Windows/Temp/mcp-trace-pwn.json']);
// download_file subdir allowed?
await probe('download_file subdir', 'download_file', { url: 'https://example.com/', filename: 'advsub/dl.html' }, []);
await probe('download_file abs path', 'download_file', { url: 'https://example.com/', filename: 'C:/Windows/Temp/dl-abs.html' }, ['C:/Windows/Temp/dl-abs.html']);
const dl = await call('list_downloads', { limit: 4 });
console.log('downloads:', text(dl).slice(0, 500));

await call('close_page', { pageId });
console.log('DONE2');
