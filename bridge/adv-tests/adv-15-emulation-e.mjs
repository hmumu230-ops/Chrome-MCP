// adv-15 part E: verify extraHttpHeaders on the wire (pure-string values).
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, nextId = 1;
async function rpc(m, p) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(BASE, { method: 'POST', headers: h, signal: AbortSignal.timeout(25000), body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: m, params: p }) });
  const ns = r.headers.get('mcp-session-id'); if (ns) sid = ns;
  const t = await r.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return { status: r.status, raw: t.slice(0, 200) }; }
}
async function call(n, a) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = (await rpc('tools/call', { name: n, arguments: a || {} })).result ?? {};
      const t = r.content && r.content[0] ? r.content[0].text : '';
      if (/extension call timeout|disconnected|not connected/i.test(t)) { await new Promise(x => setTimeout(x, 1500)); continue; }
      return r;
    } catch { sid = null; await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e', version: '0' } }).catch(() => {}); }
  }
  return { isError: true, content: [{ type: 'text', text: 'Error: unreachable' }] };
}
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e', version: '0' } });
const np = await call('new_page', { url: 'http://127.0.0.1:8199/' });
const T = np.structuredContent && np.structuredContent.pageId;
console.log('T=' + T);
await new Promise(r => setTimeout(r, 900));
let r1 = await call('emulate', { pageId: T, extraHttpHeaders: '{"X-Adv15":"yes","X-Adv15-Second":"two"}' });
console.log('emulate:', r1.content && r1.content[0].text);
let p = await call('evaluate_script', { pageId: T, function: `async()=>{const r=await fetch('/?cb=9',{cache:'no-store'});const j=await r.json();return {a:j.headers['x-adv15']||null,b:j.headers['x-adv15-second']||null}}` });
console.log('echoed headers:', JSON.stringify(p.structuredContent));
let p2 = await call('evaluate_script', { pageId: T, function: `async()=>{const r=await fetch('/?cb=10',{cache:'no-store'});const j=await r.json();return {a:j.headers['x-adv15']||null}}` });
await call('emulate', { pageId: T, extraHttpHeaders: '' });
let p3 = await call('evaluate_script', { pageId: T, function: `async()=>{const r=await fetch('/?cb=11',{cache:'no-store'});const j=await r.json();return {a:j.headers['x-adv15']||null}}` });
console.log('after clear:', JSON.stringify(p3.structuredContent));
await call('detach_debugger', { pageId: T });
await call('close_page', { pageId: T });
console.log('done');
