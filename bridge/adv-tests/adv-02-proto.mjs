// adv-02-proto.mjs — MCP/JSON-RPC protocol conformance edge cases vs chrome-mcp bridge
// READ-ONLY adversarial probe. Does not touch tabs. Run: node adv-02-proto.mjs
const BASE = 'http://127.0.0.1:7890/mcp';
const TIMEOUT = 8000;

let pass = 0, fail = 0;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title, detail }); console.log(`  [${sev}] ${title}\n      ${detail}`); };
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

// ---- transport helpers ----
async function raw(method, { body, headers = {}, rawBody } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(BASE, {
      method, signal: ac.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
      body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers, msgs: parseBody(text) };
  } catch (e) {
    return { status: -1, text: `FETCH-ERR ${e.name}: ${e.message}`, headers: new Headers(), msgs: [] };
  } finally { clearTimeout(t); }
}
function parseBody(text) {
  // SSE framed or plain JSON
  const lines = text.split('\n').filter(l => l.startsWith('data:'));
  if (lines.length) return lines.map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return { _unparsed: l }; } });
  try { return [JSON.parse(text)]; } catch { return []; }
}
const last = (r) => r.msgs[r.msgs.length - 1];
const isRpcErr = (m) => m && m.error && Number.isInteger(m.error.code) && typeof m.error.message === 'string';
const leaksStack = (r) => /node_modules|\\bridge\\|\.js:\d+|at \w+ \(/.test(r.text);
const INIT = (over = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv', version: '0.0.1' }, ...over },
});
const createdSessions = [];
async function initSession(initMsg = INIT()) {
  const r = await raw('POST', { body: initMsg });
  const sid = r.headers.get('mcp-session-id');
  if (sid) createdSessions.push(sid);
  return { r, sid };
}
const withSid = (sid, extra = {}) => ({ 'mcp-session-id': sid, ...extra });

// =================================================================
console.log('\n== A. requests BEFORE initialize (no session header) ==');
{
  const cases = [
    ['tools/call', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }],
    ['tools/list', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['ping', { jsonrpc: '2.0', id: 1, method: 'ping' }],
    ['notification notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' }],
    ['notification tools/call (no id)', { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_pages' } }],
    ['unknown method', { jsonrpc: '2.0', id: 1, method: 'foo/bar' }],
    ['batched initialize', [INIT({}), { jsonrpc: '2.0', method: 'notifications/initialized' }]],
    ['initialize WITH forged session header', INIT()],
  ];
  for (const [label, body] of cases) {
    const hdrs = label.includes('forged') ? withSid('forged-session-id-1234') : {};
    const r = await raw('POST', { body, headers: hdrs });
    if (r.status === 404) ok(`${label} -> 404`);
    else if (r.status === 400 || r.status === 406) note('LOW', `${label} -> ${r.status}`, `body: ${r.text.slice(0, 200)}`);
    else note('MED', `${label} -> ${r.status} (expected 404)`, `body: ${r.text.slice(0, 200)}`);
  }
  // initialize as notification (no id) — could hang or create orphan session
  const r = await raw('POST', { body: { jsonrpc: '2.0', method: 'initialize', params: INIT().params } });
  note(r.status === 404 ? 'LOW' : 'MED', `initialize-as-notification -> ${r.status}`, `sid: ${r.headers.get('mcp-session-id')} body: ${r.text.slice(0, 150)}`);
}

// =================================================================
console.log('\n== B. initialize edge cases ==');
let sidA;
{
  const { r, sid } = await initSession();
  sidA = sid;
  const m = last(r);
  if (r.status === 200 && sid && m?.result?.protocolVersion) ok(`initialize ok, sid=${sid.slice(0, 8)}..., proto=${m.result.protocolVersion}`);
  else { bad(`baseline initialize failed: ${r.status} ${r.text.slice(0, 200)}`); }

  // double initialize on same session
  const r2 = await raw('POST', { body: INIT({}), headers: withSid(sidA) });
  const m2 = last(r2);
  if (isRpcErr(m2)) ok(`double initialize -> JSON-RPC error ${m2.error.code}: ${m2.error.message.slice(0, 80)}`);
  else note('MED', `double initialize -> ${r2.status}`, `body: ${r2.text.slice(0, 250)}`);
  if (leaksStack(r2)) note('HIGH', 'stack trace leaked in double-init error', r2.text.slice(0, 300));

  // missing protocolVersion
  for (const [label, params] of [
    ['missing protocolVersion', { capabilities: {}, clientInfo: { name: 'a', version: '1' } }],
    ['wrong protocolVersion "1999-01-01"', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'a', version: '1' } }],
    ['numeric protocolVersion', { protocolVersion: 42, capabilities: {}, clientInfo: { name: 'a', version: '1' } }],
    ['garbage clientInfo (string)', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: 'not-an-object' }],
    ['missing params entirely', undefined],
    ['params = []', []],
    ['params = "x"', 'x'],
  ]) {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    if (params !== undefined) msg.params = params;
    const rr = await raw('POST', { body: msg });
    const mm = last(rr);
    const sid2 = rr.headers.get('mcp-session-id');
    if (sid2) { createdSessions.push(sid2); note('MED', `init ${label}: SESSION CREATED anyway`, `status ${rr.status} body ${rr.text.slice(0, 200)}`); }
    else if (isRpcErr(mm) || rr.status === 400 || rr.status === 404) ok(`init ${label} -> ${rr.status}${isRpcErr(mm) ? ` rpc-err ${mm.error.code}` : ''}`);
    else note('LOW', `init ${label} -> ${rr.status}`, rr.text.slice(0, 200));
    if (leaksStack(rr)) note('HIGH', `stack leak on init ${label}`, rr.text.slice(0, 300));
  }
}

// =================================================================
console.log('\n== C. malformed JSON-RPC on a valid session ==');
{
  const cases = [
    ['missing jsonrpc field', { id: 10, method: 'ping' }],
    ['jsonrpc:"1.0"', { jsonrpc: '1.0', id: 10, method: 'ping' }],
    ['id as string', { jsonrpc: '2.0', id: 'str-id-1', method: 'ping' }],
    ['id null (with method)', { jsonrpc: '2.0', id: null, method: 'ping' }],
    ['id float 1.5', { jsonrpc: '2.0', id: 1.5, method: 'ping' }],
    ['id object {}', { jsonrpc: '2.0', id: {}, method: 'ping' }],
    ['id array', { jsonrpc: '2.0', id: [1], method: 'ping' }],
    ['id=0', { jsonrpc: '2.0', id: 0, method: 'ping' }],
    ['id=-1', { jsonrpc: '2.0', id: -1, method: 'ping' }],
    ['id=1e18', { jsonrpc: '2.0', id: 1e18, method: 'ping' }],
    ['id=9007199254740993 (2^53+1)', { jsonrpc: '2.0', id: 9007199254740993, method: 'ping' }],
    ['no method at all', { jsonrpc: '2.0', id: 11 }],
    ['method=42', { jsonrpc: '2.0', id: 11, method: 42 }],
    ['method=""', { jsonrpc: '2.0', id: 11, method: '' }],
    ['unknown method foo/bar', { jsonrpc: '2.0', id: 11, method: 'foo/bar' }],
    ['unknown method with params', { jsonrpc: '2.0', id: 11, method: 'x/y', params: { a: 1 } }],
    ['notification WITH id (notifications/initialized id=7)', { jsonrpc: '2.0', id: 7, method: 'notifications/initialized' }],
    ['request-with-no-id tools/list', { jsonrpc: '2.0', method: 'tools/list' }],
    ['batch [ping,ping]', [{ jsonrpc: '2.0', id: 20, method: 'ping' }, { jsonrpc: '2.0', id: 21, method: 'ping' }]],
    ['batch with unknown method', [{ jsonrpc: '2.0', id: 22, method: 'ping' }, { jsonrpc: '2.0', id: 23, method: 'foo/bar' }]],
    ['batch notifications only', [{ jsonrpc: '2.0', method: 'notifications/initialized' }]],
    ['empty batch []', []],
    ['bare null body', null],
    ['bare number 42', 42],
    ['bare string', 'hello'],
    ['bare boolean', true],
    ['extra junk fields', { jsonrpc: '2.0', id: 30, method: 'ping', hack: '../../', params: null }],
    ['__proto__ pollution in params', { jsonrpc: '2.0', id: 31, method: 'tools/list', params: JSON.parse('{"__proto__":{"polluted":true}}') }],
    ['constructor key in params', { jsonrpc: '2.0', id: 32, method: 'tools/list', params: { constructor: { prototype: {} } } }],
  ];
  for (const [label, body] of cases) {
    const r = await raw('POST', { body, headers: withSid(sidA) });
    const m = last(r);
    const leaked = leaksStack(r);
    if (leaked) note('HIGH', `stack/internal leak: ${label}`, r.text.slice(0, 300));
    if (r.status === 202 || (r.status === 200 && r.text === '')) { ok(`${label} -> ${r.status} (accepted/no-body)`); continue; }
    if (m?.result !== undefined) {
      // check id echo integrity
      const sentId = Array.isArray(body) ? undefined : body?.id;
      const echoOk = sentId === undefined || JSON.stringify(m.id) === JSON.stringify(sentId);
      ok(`${label} -> result, id echo ${echoOk ? 'OK' : `MISMATCH sent=${JSON.stringify(sentId)} got=${JSON.stringify(m.id)}`}`);
      if (!echoOk) note('MED', `id echo mismatch: ${label}`, `sent ${JSON.stringify(sentId)} got ${JSON.stringify(m.id)}`);
    } else if (isRpcErr(m)) {
      ok(`${label} -> rpc error ${m.error.code} (${m.error.message.slice(0, 60)})`);
    } else if (Array.isArray(r.msgs) && r.msgs.length > 1) {
      ok(`${label} -> ${r.msgs.length} msgs (batch expanded)`);
    } else {
      note('MED', `${label} -> ${r.status}, non-RPC body`, r.text.slice(0, 200));
    }
  }
}

// =================================================================
console.log('\n== D. session-id abuse ==')
{
  const forged = ['../../etc', '__proto__', 'constructor', 'prototype', 'x'.repeat(4096), 'null', 'undefined', sidA + 'x', '', '  '];
  for (const f of forged) {
    const r = await raw('POST', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'mcp-session-id': f } });
    if (r.status === 404) ok(`forged sid ${JSON.stringify(f.slice(0, 30))}${f.length > 30 ? `(${f.length}B)` : ''} -> 404`);
    else note('MED', `forged sid ${JSON.stringify(f.slice(0, 40))} -> ${r.status}`, r.text.slice(0, 200));
  }
  // valid sid on a *different* tool/session works — confirms no client binding
  const r = await raw('POST', { body: { jsonrpc: '2.0', id: 5, method: 'ping' }, headers: withSid(sidA) });
  if (last(r)?.result !== undefined) note('LOW', 'session id is a bearer token — any local client knowing UUID can hijack', 'No per-connection binding (spec-allowed, but worth noting for local threat model)');
  // 64KB header — Node rejects before app sees it
  try {
    const r2 = await raw('POST', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'mcp-session-id': 'y'.repeat(64 * 1024) } });
    note('LOW', `64KB session header -> ${r2.status}`, r2.text.slice(0, 120));
  } catch (e) { note('LOW', '64KB session header rejected at HTTP layer', e.message); }
}

// =================================================================
console.log('\n== E. DELETE /mcp semantics ==');
let deadSid;
{
  const { sid } = await initSession(INIT({ id: 2 }));
  deadSid = sid;
  const d1 = await raw('DELETE', { headers: withSid(deadSid) });
  ok(`DELETE live session -> ${d1.status}${d1.status === 200 ? '' : ' (expected 200)'}`);
  const d2 = await raw('DELETE', { headers: withSid(deadSid) });
  ok(`DELETE same session again -> ${d2.status}${d2.status === 404 ? ' (gone, correct)' : ' (still alive?)'}`);
  const r = await raw('POST', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: withSid(deadSid) });
  ok(`POST on deleted session -> ${r.status}${r.status === 404 ? ' (correct)' : ' (UNEXPECTED)'}`);
  const d3 = await raw('DELETE', { headers: {} });
  ok(`DELETE no session -> ${d3.status}`);
  const d4 = await raw('DELETE', { headers: { 'mcp-session-id': '__proto__' } });
  ok(`DELETE forged session -> ${d4.status}`);
}

// =================================================================
console.log('\n== F. GET /mcp SSE stream ==');
{
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2500);
  try {
    const r = await fetch(BASE, { method: 'GET', headers: { 'mcp-session-id': sidA, 'accept': 'text/event-stream' }, signal: ac.signal });
    const ct = r.headers.get('content-type');
    if (r.status === 200 && ct?.includes('text/event-stream')) ok(`GET session -> 200 SSE stream (${ct})`);
    else note('LOW', `GET session -> ${r.status} ${ct}`, (await r.text().catch(() => '')).slice(0, 150));
  } catch (e) {
    if (e.name === 'AbortError') ok('GET session -> stream stayed open (SSE), aborted after 2.5s');
    else note('LOW', 'GET session fetch error', e.message);
  } finally { clearTimeout(t); }
  const g2 = await raw('GET', {});
  ok(`GET no session -> ${g2.status}`);
  const g3 = await raw('GET', { headers: { 'mcp-session-id': 'forged' } });
  ok(`GET forged session -> ${g3.status}`);
  const g4 = await raw('GET', { headers: withSid(deadSid) });
  ok(`GET dead session -> ${g4.status}`);
}

// =================================================================
console.log('\n== G. tools/call argument edge cases ==');
{
  const cases = [
    ['missing name', { arguments: {} }],
    ['name null', { name: null, arguments: {} }],
    ['name number', { name: 42, arguments: {} }],
    ['name ""', { name: '', arguments: {} }],
    ['name "__proto__"', { name: '__proto__', arguments: {} }],
    ['name with traversal', { name: '../../etc/passwd', arguments: {} }],
    ['nonexistent tool', { name: 'definitely_not_a_tool', arguments: {} }],
    ['arguments null', { name: 'list_pages', arguments: null }],
    ['arguments string', { name: 'list_pages', arguments: 'x=1' }],
    ['arguments array', { name: 'list_pages', arguments: [1, 2] }],
    ['arguments number', { name: 'list_pages', arguments: 7 }],
    ['arguments omitted', { name: 'list_pages' }],
    ['missing params entirely', undefined],
    ['__proto__ in arguments', { name: 'list_pages', arguments: JSON.parse('{"__proto__":{"x":1}}') }],
  ];
  for (const [label, params] of cases) {
    const msg = { jsonrpc: '2.0', id: 40, method: 'tools/call' };
    if (params !== undefined) msg.params = params;
    const r = await raw('POST', { body: msg, headers: withSid(sidA) });
    const m = last(r);
    if (leaksStack(r)) note('HIGH', `stack leak tools/call ${label}`, r.text.slice(0, 300));
    if (isRpcErr(m)) ok(`tools/call ${label} -> rpc err ${m.error.code} ${m.error.message.slice(0, 60)}`);
    else if (m?.result?.isError) {
      const txt = m.result.content?.[0]?.text || '';
      note('LOW', `tools/call ${label} -> isError result (not rpc error)`, txt.slice(0, 120));
    }
    else if (m?.result) ok(`tools/call ${label} -> result ok`);
    else note('MED', `tools/call ${label} -> ${r.status}`, r.text.slice(0, 200));
  }
}

// =================================================================
console.log('\n== H. tools/list, ping, unimplemented endpoints ==');
{
  const cases = [
    ['ping', { jsonrpc: '2.0', id: 50, method: 'ping' }],
    ['tools/list normal', { jsonrpc: '2.0', id: 51, method: 'tools/list' }],
    ['tools/list params string', { jsonrpc: '2.0', id: 52, method: 'tools/list', params: 'junk' }],
    ['tools/list params array', { jsonrpc: '2.0', id: 53, method: 'tools/list', params: [1] }],
    ['tools/list extra fields', { jsonrpc: '2.0', id: 54, method: 'tools/list', params: { cursor: 'evil', x: {} } }],
    ['prompts/list (not advertised)', { jsonrpc: '2.0', id: 55, method: 'prompts/list' }],
    ['resources/list (not advertised)', { jsonrpc: '2.0', id: 56, method: 'resources/list' }],
    ['resources/templates/list', { jsonrpc: '2.0', id: 57, method: 'resources/templates/list' }],
    ['completion/complete', { jsonrpc: '2.0', id: 58, method: 'completion/complete', params: {} }],
    ['logging/setLevel', { jsonrpc: '2.0', id: 59, method: 'logging/setLevel', params: { level: 'debug' } }],
    ['notifications/cancelled with garbage', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: {} } }],
    ['notifications/progress garbage', { jsonrpc: '2.0', method: 'notifications/progress', params: 'x' }],
  ];
  for (const [label, body] of cases) {
    const r = await raw('POST', { body, headers: withSid(sidA) });
    const m = last(r);
    if (leaksStack(r)) note('HIGH', `stack leak ${label}`, r.text.slice(0, 300));
    if (r.status === 202) { ok(`${label} -> 202 (notif accepted)`); continue; }
    if (m?.result !== undefined) ok(`${label} -> result`);
    else if (isRpcErr(m)) ok(`${label} -> rpc err ${m.error.code} ${m.error.message.slice(0, 70)}`);
    else note('MED', `${label} -> ${r.status}`, r.text.slice(0, 200));
  }
}

// =================================================================
console.log('\n== I. HTTP-layer edge cases ==');
{
  // empty body with session
  const r1 = await raw('POST', { rawBody: '', headers: withSid(sidA) });
  note(r1.status >= 400 ? 'LOW' : 'MED', `empty POST body w/session -> ${r1.status}`, r1.text.slice(0, 150));
  // invalid JSON
  const r2 = await raw('POST', { rawBody: '{not json', headers: withSid(sidA) });
  ok(`invalid JSON -> ${r2.status} ${r2.text.slice(0, 80)}`);
  // content-type text/plain, valid JSON
  const r3 = await raw('POST', { body: { jsonrpc: '2.0', id: 60, method: 'ping' }, headers: { ...withSid(sidA), 'content-type': 'text/plain' } });
  note(r3.status === 415 || r3.status === 400 ? 'LOW' : 'MED', `wrong content-type -> ${r3.status}`, r3.text.slice(0, 150));
  // no accept header
  const r4 = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': sidA }, body: JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'ping' }) });
  const t4 = await r4.text();
  note(r4.status === 406 || r4.status === 400 ? 'LOW' : 'MED', `missing Accept -> ${r4.status}`, t4.slice(0, 150));
  // initialize without SSE accept
  const r5 = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' }, body: JSON.stringify(INIT({ id: 70 })) });
  const t5 = await r5.text();
  const s5 = r5.headers.get('mcp-session-id'); if (s5) createdSessions.push(s5);
  note(r5.status === 200 ? 'MED' : 'LOW', `initialize w/o SSE accept -> ${r5.status}${s5 ? ' SESSION CREATED' : ''}`, t5.slice(0, 150));
  // path variants
  for (const p of ['/mcp/', '/MCP', '/mcp/x', '/mcp?x=1']) {
    const rr = await fetch(`http://127.0.0.1:7890${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': sidA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    ok(`POST ${p} -> ${rr.status}`);
  }
  // foreign origin (DNS rebinding guard)
  const r6 = await raw('POST', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { ...withSid(sidA), origin: 'http://evil.example.com' } });
  ok(`foreign origin -> ${r6.status}${r6.status === 403 ? ' (blocked)' : ' NOT BLOCKED?'}`);
  // PUT / PATCH
  for (const meth of ['PUT', 'PATCH', 'OPTIONS']) {
    const rr = await raw(meth, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: withSid(sidA) });
    ok(`${meth} /mcp -> ${rr.status}`);
  }
}

// =================================================================
console.log('\n== J. id collisions across two live sessions ==');
{
  const { sid: sidB } = await initSession(INIT({ id: 90 }));
  if (sidB === sidA) note('HIGH', 'session id collision — generator returned same UUID', sidA);
  const r1 = await raw('POST', { body: { jsonrpc: '2.0', id: 999, method: 'ping' }, headers: withSid(sidA) });
  const r2 = await raw('POST', { body: { jsonrpc: '2.0', id: 999, method: 'ping' }, headers: withSid(sidB) });
  ok(`same id=999 on two sessions -> ${last(r1)?.result !== undefined && last(r2)?.result !== undefined ? 'both OK (independent)' : 'problem'}`);
  // huge id on session B
  const r3 = await raw('POST', { body: { jsonrpc: '2.0', id: 1e30, method: 'ping' }, headers: withSid(sidB) });
  const m3 = last(r3);
  if (m3?.result !== undefined) note(JSON.stringify(m3.id) === '1e+30' || m3.id === 1e30 ? 'LOW' : 'MED', `id=1e30 echo: ${JSON.stringify(m3?.id)}`, 'precision/coercion in id echo');
  else if (isRpcErr(m3)) ok(`id=1e30 -> rpc err ${m3.error.code}`);
}

// cleanup sessions we created (leave user sessions alone)
for (const s of createdSessions) { try { await raw('DELETE', { headers: withSid(s) }); } catch {} }

console.log(`\n===== SUMMARY: ${pass} ok-ish, ${fail} hard fails, ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`${i + 1}. [${f.sev}] ${f.title} — ${f.detail}`));
