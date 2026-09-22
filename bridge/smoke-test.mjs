// Smoke test: initialize -> tools/list -> tools/call(list_pages without extension)
const BASE = 'http://127.0.0.1:7890/mcp';

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
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { data, sid: sidOut };
}

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
const sid = init.sid;
console.log('initialize:', init.data[0].result.serverInfo, '| session:', sid);

await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
const tools = list.data[0].result.tools;
console.log('tools:', tools.length, '|', tools.map(t => t.name).join(', '));

const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, sid);
console.log('call list_pages →', JSON.stringify(call.data[0].result || call.data[0].error));
