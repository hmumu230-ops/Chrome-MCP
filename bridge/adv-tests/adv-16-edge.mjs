// adv-16-edge.mjs — param edge cases for download_file. Usage: node.exe adv-16-edge.mjs
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, idc = 0;
async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return { raw: t }; }
}
await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'edge', version: '0' } });
const txt = r => (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r);

const cases = [
  ['prompt-fresh', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 'mcp-test-prompt.txt', conflictAction: 'prompt' }],
  ['conflict-bogus', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 'mcp-test-badconf.txt', conflictAction: 'bogus' }],
  ['filename-number', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 12345 }],
  ['filename-array', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: ['a', 'b'] }],
  ['filename-null', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: null }],
  ['url-number', { url: 12345 }],
  ['no-args', {}],
  ['url-null', { url: null }],
  ['url-array', { url: ['http://127.0.0.1:8137/file/testfile.txt'] }],
  ['filename-empty', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: '' }],
  ['long-name-300', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 'mcp-test-' + 'x'.repeat(300) + '.txt' }],
  ['newline-name', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 'mcp-test-a\nb.txt' }],
  ['unicode-name', { url: 'http://127.0.0.1:8137/file/testfile.txt', filename: 'mcp-test-你好.txt' }],
  ['data-html-exe-name', { url: 'data:application/octet-stream;base64,TVo=', filename: 'mcp-test-data-exe.exe' }],
];
for (const [name, args] of cases) {
  try {
    const r = await req('tools/call', { name: 'download_file', arguments: args });
    const t = txt(r.result ?? r).replace(/\s+/g, ' ').slice(0, 220);
    console.log(name + ' -> ' + t);
  } catch (e) { console.log(name + ' EXC ' + e.message); }
}
