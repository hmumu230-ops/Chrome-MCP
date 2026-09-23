// Smoke test: initialize -> tools/list -> tools/call(list_pages).
// Runs without Chrome — expects a clean "extension not connected" error.
// Exits non-zero on failure so CI can gate on it.
const BASE = process.env.MCP_URL || 'http://127.0.0.1:7890/mcp';
let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failed++;
};

async function rpc(body, sid) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const sidOut = res.headers.get('mcp-session-id');
  const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { data: msgs, sid: sidOut, status: res.status };
}

// status endpoint
const status = await fetch(BASE.replace('/mcp', '/')).then(r => r.json());
ok('status endpoint', status.mcpEndpoint === BASE, status.mcpEndpoint);

// evil origin rejected (DNS-rebinding defense)
const evil = await fetch(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'origin': 'https://evil.example' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
});
ok('evil Origin rejected', evil.status === 403, 'status ' + evil.status);

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
ok('initialize', !!init.data[0]?.result?.serverInfo, init.data[0]?.result?.serverInfo?.name);
const sid = init.sid;
ok('session id issued', !!sid);

await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
const tools = list.data[0]?.result?.tools || [];
ok('tools/list = 37 tools', tools.length === 37, `${tools.length} tools`);

const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, sid);
const res = call.data[0]?.result || call.data[0]?.error;
const txt = JSON.stringify(res);
if (status.extensionConnected) {
  ok('list_pages returns tabs', Array.isArray(res?.structuredContent?.items) || (res?.content?.[0]?.text || '').includes('pageId'), txt.slice(0, 80));
} else {
  ok('no-extension error surfaced', /not connected/i.test(txt), txt.slice(0, 80));
}

// stale session -> 404 (client should re-initialize)
const stale = await fetch(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-session-id': 'deadbeef' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
});
ok('stale session -> 404', stale.status === 404, 'status ' + stale.status);

console.log(`\n${failed === 0 ? 'SMOKE OK' : 'SMOKE FAILED'} (${failed} failures)`);
// Natural exit (not process.exit) — undici keep-alive sockets trip a libuv
// assertion on Windows otherwise; exitCode still gates CI.
process.exitCode = failed === 0 ? 0 : 1;
