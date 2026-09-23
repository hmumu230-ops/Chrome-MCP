// adv-17-rpcfuzz.mjs — malformed JSON-RPC fuzz vs chrome-mcp bridge.
// Verifies: proper -32600/-32601/-32602 errors (never a crash, never a hang,
// never a stack leak). Sections: envelope fuzz, id fuzz, method/params fuzz,
// unknown methods, batches (0/1/100/mixed), unicode bombs, deep nesting,
// duplicate keys, raw-body garbage.
// Run on Windows node: node adv-17-rpcfuzz.mjs
const MCP = 'http://127.0.0.1:7890/mcp';
const ROOT = 'http://127.0.0.1:7890/';
const T = 12000;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title, detail }); console.log(`  [${sev}] ${title} :: ${detail}`); };
const ok = (m) => console.log(`  PASS ${m}`);

const INIT = (id) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv17', version: '0.1' } },
});

async function post(body, headers = {}, rawBody) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), T);
  try {
    const r = await fetch(MCP, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, sid: r.headers.get('mcp-session-id'), msgs: parseMsgs(text) };
  } catch (e) { return { status: -1, text: `FETCH-ERR ${e.name}: ${e.message}`, msgs: [] }; }
  finally { clearTimeout(t); }
}
function parseMsgs(text) {
  const dl = text.split('\n').filter(l => l.startsWith('data:'));
  if (dl.length) return dl.map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return { _raw: l.slice(0, 120) }; } });
  try { return [JSON.parse(text)]; } catch { return []; }
}
const lastMsg = (r) => r.msgs[r.msgs.length - 1];
const isRpcErr = (m) => m && m.error && Number.isInteger(m.error.code);
const stackLeak = (r) => /at \w+ \(|node_modules|\\\\bridge\\\\|\.js:\d+:\d+/.test(r.text);
const alive = async () => { try { const s = JSON.parse(await (await fetch(ROOT)).text()); return s.name === 'chrome-mcp-bridge'; } catch { return false; } };

// ---- get a session ----
const initR = await post(INIT(1));
const SID = initR.sid;
if (!SID) { console.log('FATAL: cannot init session: ' + initR.status + ' ' + initR.text); process.exit(1); }
console.log(`session: ${SID.slice(0, 8)}...`);
const authed = { 'mcp-session-id': SID };
const created = [SID];

async function runCases(title, cases, useSid = true) {
  console.log(`\n== ${title} ==`);
  for (const [label, body, rawOverride] of cases) {
    const r = await post(body, useSid ? authed : {}, rawOverride);
    const m = lastMsg(r);
    if (stackLeak(r)) note('HIGH', `stack/internal leak: ${label}`, r.text.slice(0, 250));
    if (r.status === -1) { note('HIGH', `${label}: fetch failed/hung`, r.text); if (!(await alive())) note('CRITICAL', 'BRIDGE DOWN after ' + label, ''); continue; }
    if (r.status === 202) { ok(`${label} -> 202`); continue; }
    if (Array.isArray(m) || (r.msgs.length > 1 && r.msgs.every(x => x && (x.result !== undefined || isRpcErr(x))))) {
      ok(`${label} -> batch of ${r.msgs.length} msgs`); continue;
    }
    if (m?.result !== undefined) { ok(`${label} -> result (echo id=${JSON.stringify(m.id)})`); continue; }
    if (isRpcErr(m)) { ok(`${label} -> rpc err ${m.error.code}: ${String(m.error.message).slice(0, 70)}`); continue; }
    if ([400, 404, 405, 406, 413, 415].includes(r.status)) { ok(`${label} -> HTTP ${r.status} ${r.text.slice(0, 80)}`); continue; }
    note('MED', `${label} -> ${r.status} unclassified`, r.text.slice(0, 200));
  }
}

// ============ A. envelope fuzz ============
await runCases('A. envelope fuzz (valid session)', [
  ['{"jsonrpc":"2.0"} alone', undefined, '{"jsonrpc":"2.0"}'],
  ['{} empty object', undefined, '{}'],
  ['jsonrpc only + id', undefined, '{"jsonrpc":"2.0","id":1}'],
  ['method only, no jsonrpc', { id: 1, method: 'ping' }],
  ['jsonrpc "1.0"', { jsonrpc: '1.0', id: 1, method: 'ping' }],
  ['jsonrpc 2.0 numeric', { jsonrpc: 2.0, id: 1, method: 'ping' }],
  ['jsonrpc null', { jsonrpc: null, id: 1, method: 'ping' }],
  ['jsonrpc array', { jsonrpc: ['2.0'], id: 1, method: 'ping' }],
  ['bare null', null],
  ['bare 42', 42],
  ['bare "ping"', 'ping'],
  ['bare true', true],
  ['raw empty body', undefined, ''],
  ['raw whitespace', undefined, '   \n\t '],
  ['raw invalid json', undefined, '{not json'],
  ['raw truncated', undefined, '{"jsonrpc":"2.0","id":1,"method":"pi'],
  ['raw BOM + json', undefined, '\uFEFF{"jsonrpc":"2.0","id":1,"method":"ping"}'],
  ['raw trailing garbage', undefined, '{"jsonrpc":"2.0","id":1,"method":"ping"}EXTRA'],
  ['raw two objects', undefined, '{"jsonrpc":"2.0","id":1,"method":"ping"}{"jsonrpc":"2.0","id":2,"method":"ping"}'],
  ['raw NaN', undefined, '{"jsonrpc":"2.0","id":NaN,"method":"ping"}'],
  ['raw Infinity', undefined, '{"jsonrpc":"2.0","id":Infinity,"method":"ping"}'],
  ['raw +1 id', undefined, '{"jsonrpc":"2.0","id":+1,"method":"ping"}'],
  ['raw single-quoted', undefined, "{'jsonrpc':'2.0','id':1,'method':'ping'}"],
]);

// ============ B. id fuzz ============
await runCases('B. id type fuzz', [
  ['id string', { jsonrpc: '2.0', id: 'string-id', method: 'ping' }],
  ['id empty string', { jsonrpc: '2.0', id: '', method: 'ping' }],
  ['id negative -1', { jsonrpc: '2.0', id: -1, method: 'ping' }],
  ['id -0', { jsonrpc: '2.0', id: -0, method: 'ping' }],
  ['id float 1.5', { jsonrpc: '2.0', id: 1.5, method: 'ping' }],
  ['id null', { jsonrpc: '2.0', id: null, method: 'ping' }],
  ['id object', { jsonrpc: '2.0', id: { nested: 1 }, method: 'ping' }],
  ['id array', { jsonrpc: '2.0', id: [1, 2], method: 'ping' }],
  ['id bool', { jsonrpc: '2.0', id: true, method: 'ping' }],
  ['id 2^53+1', { jsonrpc: '2.0', id: 9007199254740993, method: 'ping' }],
  ['id 1e30', { jsonrpc: '2.0', id: 1e30, method: 'ping' }],
  ['id very long string', { jsonrpc: '2.0', id: 'x'.repeat(8192), method: 'ping' }],
  ['id unicode', { jsonrpc: '2.0', id: 'id-\u0000-\u2028-\u{1F4A9}', method: 'ping' }],
]);

// ============ C. method & params fuzz ============
await runCases('C. method/params fuzz', [
  ['method null', { jsonrpc: '2.0', id: 1, method: null }],
  ['method 42', { jsonrpc: '2.0', id: 1, method: 42 }],
  ['method object', { jsonrpc: '2.0', id: 1, method: { m: 'ping' } }],
  ['method array', { jsonrpc: '2.0', id: 1, method: ['ping'] }],
  ['method ""', { jsonrpc: '2.0', id: 1, method: '' }],
  ['method bool', { jsonrpc: '2.0', id: 1, method: true }],
  ['params string', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: 'junk-string' }],
  ['params array', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1, 2, 3] }],
  ['params number', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: 42 }],
  ['params null', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: null }],
  ['params bool', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: true }],
  ['tools/call params string', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'x' }],
  ['tools/call params array', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: ['list_pages'] }],
]);

// ============ D. unknown methods ============
await runCases('D. unknown methods (expect -32601 or -32602)', [
  ['foo/bar', { jsonrpc: '2.0', id: 1, method: 'foo/bar' }],
  ['tools/call/ nested', { jsonrpc: '2.0', id: 1, method: 'tools/call/x' }],
  ['TOOLS/LIST upper', { jsonrpc: '2.0', id: 1, method: 'TOOLS/LIST' }],
  ['rpc.discover', { jsonrpc: '2.0', id: 1, method: 'rpc.discover' }],
  ['system.method', { jsonrpc: '2.0', id: 1, method: 'system.exec' }],
  ['../../ traversal method', { jsonrpc: '2.0', id: 1, method: '../../tools/list' }],
  ['method with null byte', { jsonrpc: '2.0', id: 1, method: 'ping\u0000x' }],
  ['method very long', { jsonrpc: '2.0', id: 1, method: 'm/'.repeat(2000) }],
  ['prompts/list unadvertised', { jsonrpc: '2.0', id: 1, method: 'prompts/list' }],
  ['resources/list unadvertised', { jsonrpc: '2.0', id: 1, method: 'resources/list' }],
]);

// ============ E. batches ============
console.log('\n== E. batch arrays ==');
{
  const cases = [
    ['empty batch []', '[]'],
    ['batch x1 [ping]', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])],
    ['batch x2 [ping,ping]', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])],
    ['batch notifications only', JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])],
    ['batch mixed valid+invalid', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { bad: true }, { jsonrpc: '2.0', id: 3, method: 'foo/bar' }, 'junk', null])],
    ['batch all invalid', JSON.stringify([{ bad: 1 }, { worse: 2 }, 42])],
    ['batch nested array', JSON.stringify([[{ jsonrpc: '2.0', id: 1, method: 'ping' }]])],
    ['batch with initialize inside', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, INIT(77)])],
  ];
  for (const [label, rawBody] of cases) {
    const r = await post(undefined, authed, rawBody);
    if (stackLeak(r)) note('HIGH', `stack leak ${label}`, r.text.slice(0, 250));
    if (r.status === -1) { note('HIGH', `${label} fetch fail`, r.text); continue; }
    const errs = r.msgs.filter(isRpcErr).length;
    ok(`${label} -> ${r.status}, ${r.msgs.length} msgs (${errs} rpc errs) ${r.text.slice(0, 100)}`);
  }
  // 100-item batch
  const big = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' })));
  const t0 = Date.now();
  const r100 = await post(undefined, authed, big);
  const dt = Date.now() - t0;
  const results = r100.msgs.filter(m => m?.result !== undefined).length;
  console.log(`  batch x100 pings -> ${r100.status}, ${r100.msgs.length} msgs, ${results} results, ${dt}ms`);
  if (r100.status === -1 || !(await alive())) note('HIGH', 'batch x100 broke the bridge', r100.text.slice(0, 150));
  else if (results === 100) ok('batch x100 -> all 100 answered');
  else note('MED', `batch x100 -> ${results}/100 results`, r100.text.slice(0, 200));
}

// ============ F. unicode bombs ============
await runCases('F. unicode bombs in params', [
  ['lone surrogate', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\uD800' } }],
  ['RTL override flood', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\u202E'.repeat(5000) } }],
  ['null bytes', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: 'a\u0000b\u0000c' } }],
  ['zero-width joiners', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\u200D'.repeat(2000) } }],
  ['emoji flood', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\u{1F4A9}'.repeat(10000) } }],
  ['combining chars', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: 'e\u0301'.repeat(5000) } }],
  ['huge key name', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { ['k'.repeat(65536)]: 1 } }],
  ['private-use area', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\uE000'.repeat(4000) } }],
  ['tag chars', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: '\u{E0001}\u{E007F}' } }],
]);

// ============ G. deep nesting ============
console.log('\n== G. deeply nested JSON ==');
{
  for (const depth of [100, 1000, 5000]) {
    let v = 1;
    for (let i = 0; i < depth; i++) v = { a: v };
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'x', deep: v } };
    let raw;
    try { raw = JSON.stringify(body); } catch (e) { note('LOW', `depth ${depth}: stringify failed locally`, e.message); continue; }
    const t0 = Date.now();
    const r = await post(undefined, authed, raw);
    const dt = Date.now() - t0;
    if (stackLeak(r)) note('HIGH', `stack leak depth=${depth}`, r.text.slice(0, 250));
    if (r.status === -1) { note('HIGH', `depth ${depth}: fetch fail (${dt}ms)`, r.text); if (!(await alive())) note('CRITICAL', `bridge down after depth ${depth}`, ''); continue; }
    ok(`depth ${depth} -> ${r.status} in ${dt}ms ${r.text.slice(0, 90)}`);
  }
  // raw-body nesting beyond JSON.stringify's own output: manual brackets
  const deep = '{"a":'.repeat(10000) + '1' + '}'.repeat(10000);
  const r = await post(undefined, authed, `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"d":${deep}}}`);
  if (r.status === -1) { note('HIGH', 'depth 10000 raw: fetch fail', r.text); if (!(await alive())) note('CRITICAL', 'bridge down after depth-10000', ''); }
  else ok(`depth 10000 raw -> ${r.status} ${r.text.slice(0, 90)}`);
}

// ============ H. duplicate keys ============
await runCases('H. duplicate keys (raw body)', [
  ['dup id (1 vs 2)', undefined, '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}'],
  ['dup method (ping vs bogus)', undefined, '{"jsonrpc":"2.0","id":1,"method":"ping","method":"bogus/x"}'],
  ['dup method reversed', undefined, '{"jsonrpc":"2.0","id":1,"method":"bogus/x","method":"ping"}'],
  ['dup jsonrpc', undefined, '{"jsonrpc":"1.0","jsonrpc":"2.0","id":1,"method":"ping"}'],
  ['dup params', undefined, '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"a":1},"params":{"a":2}}'],
]);

// ============ I. oversized body ============
console.log('\n== I. body size limits ==');
{
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'P'.repeat(4 * 1024 * 1024 + 100) } });
  const r = await post(undefined, authed, big);
  ok(`4MB+ body -> ${r.status} ${r.status === 413 ? '(correct)' : '(expected 413)'} ${r.text.slice(0, 80)}`);
  const just = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'P'.repeat(4 * 1024 * 1024 - 400) } });
  const r2 = await post(undefined, authed, just);
  ok(`~4MB body -> ${r2.status} ${r2.text.slice(0, 80)}`);
}

// ============ survival ============
const okEnd = await alive();
console.log(`\nbridge alive at end: ${okEnd}`);
if (!okEnd) note('CRITICAL', 'bridge did not survive fuzz', '');
for (const s of created) { try { await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': s } }); } catch {} }
console.log(`===== adv-17 done: ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`${i + 1}. [${f.sev}] ${f.title} — ${f.detail}`));
