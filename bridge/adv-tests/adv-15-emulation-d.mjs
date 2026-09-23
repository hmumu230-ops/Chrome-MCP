// adv-15 part D: verify extraHttpHeaders reaches the wire via echo server :8199,
// characterize colorScheme 'purple', cleanup.
const BASE = 'http://127.0.0.1:7890/mcp';
const ECHO = 'http://127.0.0.1:8199/';
let sid = null, nextId = 1;
const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv15d', version: '0' } };
async function rpcOnce(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, signal: AbortSignal.timeout(25000), body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  const ns = res.headers.get('mcp-session-id'); if (ns) sid = ns;
  const t = await res.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return { raw: t.slice(0, 300), status: res.status }; }
}
async function rpc(method, params) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await rpcOnce(method, params);
      if (r && (r.status === 404 || r.status === 503) && method !== 'initialize') { sid = null; await rpcOnce('initialize', INIT); continue; }
      return r;
    } catch { await new Promise(r => setTimeout(r, 1500)); sid = null; await rpcOnce('initialize', INIT).catch(() => {}); }
  }
  return { fatal: 'dead' };
}
const textOf = r => (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r).slice(0, 400);
const errOf = r => (r && r.fatal) ? 'transport: ' + r.fatal : (r && (r.isError || /^Error:/.test(textOf(r)))) ? textOf(r).slice(0, 160) : null;
async function call(name, args = {}) {
  for (let i = 0; i < 4; i++) {
    const res = (await rpc('tools/call', { name, arguments: args })).result ?? {};
    if (/extension call timeout|extension disconnected|extension not connected/i.test(textOf(res))) { await new Promise(x => setTimeout(x, 1500)); continue; }
    return res;
  }
  return { isError: true, content: [{ type: 'text', text: 'Error: unreachable' }] };
}
async function ev(pageId, fn) {
  const r = await call('evaluate_script', { pageId, function: fn });
  const e = errOf(r); if (e) return { __err: e };
  return r.structuredContent && 'result' in r.structuredContent ? r.structuredContent.result : { __err: 'none' };
}
const results = [];
const check = (n, p, e) => { results.push({ n, p: !!p }); console.log((p ? 'PASS' : 'FAIL') + ' | ' + n + ' | ' + e); };

await rpc('initialize', INIT);
const np = await call('new_page', { url: ECHO });
const T = np.structuredContent && np.structuredContent.pageId;
if (!T) { console.log('FATAL ' + textOf(np)); process.exit(1); }
await new Promise(r => setTimeout(r, 900));

// sanity: echo reachable
let p = await ev(T, `async()=>{const r=await fetch('/?cb=1',{cache:'no-store'});const j=await r.json();return j.headers['user-agent']||null}`);
console.log('echo UA:', JSON.stringify(p));

let r = await call('emulate', { pageId: T, extraHttpHeaders: '{"X-Adv15":"yes","X-Adv15-Num":123}' });
console.log('emulate headers (non-string value 123):', textOf(r).slice(0, 150));
p = await ev(T, `async()=>{const r=await fetch('/?cb=2',{cache:'no-store'});const j=await r.json();return {a:j.headers['x-adv15'],n:j.headers['x-adv15-num'],ua:j.headers['user-agent']}}`);
check('extraHttpHeaders reach the wire', p && p.a === 'yes', JSON.stringify(p));

r = await call('emulate', { pageId: T, extraHttpHeaders: '' });
p = await ev(T, `async()=>{const r=await fetch('/?cb=3',{cache:'no-store'});const j=await r.json();return {a:j.headers['x-adv15']||null}}`);
check('extraHttpHeaders "" clears', p && p.a === null, JSON.stringify(p));

// colorScheme 'purple' — what state does it leave matchMedia in?
r = await call('emulate', { pageId: T, colorScheme: 'purple' });
p = await ev(T, `()=>({d:matchMedia('(prefers-color-scheme: dark)').matches,l:matchMedia('(prefers-color-scheme: light)').matches,n:matchMedia('(prefers-color-scheme: no-preference)').matches})`);
check("colorScheme 'purple' accepted silently, media state", !errOf(r), 'err=' + (errOf(r) || 'none') + ' media=' + JSON.stringify(p));
await call('emulate', { pageId: T, colorScheme: 'auto' });

// cleanup
await call('emulate', { pageId: T, viewport: '', cpuThrottlingRate: 1, userAgent: '', colorScheme: 'auto', geolocation: '', extraHttpHeaders: '' });
await call('detach_debugger', { pageId: T });
await call('close_page', { pageId: T });
console.log('\n===== PART D: ' + results.filter(x => x.p).length + ' PASS, ' + results.filter(x => !x.p).length + ' FAIL =====');
