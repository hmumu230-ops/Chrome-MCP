// adv-16-initflood.mjs — REGRESSION: notification-style initialize must not leak
// sessions (was a DoS: each notification-init created a transport the client
// could never address, leaking until 45min TTL; ~50 = server full).
// Also: concurrent initialize flood (30 parallel), double-initialize.
// Run on Windows node: node adv-16-initflood.mjs
const MCP = 'http://127.0.0.1:7890/mcp';
const ROOT = 'http://127.0.0.1:7890/';
const T = 10000;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title, detail }); console.log(`  [${sev}] ${title} :: ${detail}`); };
const ok = (m) => console.log(`  PASS ${m}`);

async function status() {
  try { return JSON.parse(await (await fetch(ROOT)).text()); } catch (e) { return { err: e.message }; }
}
async function post(body, headers = {}, rawBody) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), T);
  try {
    const r = await fetch(MCP, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, sid: r.headers.get('mcp-session-id') };
  } catch (e) { return { status: -1, text: `FETCH-ERR ${e.name}: ${e.message}` }; }
  finally { clearTimeout(t); }
}
const INIT = (id) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv16', version: '0.1' } },
});
const NOTIFY_INIT = { jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv16', version: '0.1' } } };

// helper: fresh session + verify tools/call works, then DELETE it
async function verifyToolsCall(tag) {
  const r = await post(INIT(9000));
  const sid = r.sid;
  if (r.status !== 200 || !sid) { note('HIGH', `${tag}: cannot create session`, `${r.status} ${r.text.slice(0, 150)}`); return false; }
  const c = await post({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, { 'mcp-session-id': sid });
  const worked = c.status === 200 && /result|content/.test(c.text);
  if (worked) ok(`${tag}: tools/call(list_pages) works post-flood`);
  else note('HIGH', `${tag}: tools/call FAILED post-flood`, `${c.status} ${c.text.slice(0, 200)}`);
  await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => {});
  return worked;
}

// ============ 1. SEQUENTIAL notification-init x60 ============
console.log('\n== 1. notification-style initialize x60 (sequential) ==');
{
  const before = await status();
  console.log(`  sessions before: ${before.sessions}`);
  const codes = {}; let leaked = 0;
  for (let i = 0; i < 60; i++) {
    const r = await post(NOTIFY_INIT);
    codes[r.status] = (codes[r.status] || 0) + 1;
    if (r.sid) { leaked++; await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': r.sid } }).catch(() => {}); }
  }
  const after = await status();
  console.log(`  status codes: ${JSON.stringify(codes)}  sessions after: ${after.sessions}  sid headers leaked: ${leaked}`);
  if (leaked > 0) note('CRITICAL', 'notification-init leaks sessions', `${leaked}/60 returned mcp-session-id`);
  else if (after.sessions - before.sessions > 2) note('HIGH', 'session count grew without sid headers', `${before.sessions} -> ${after.sessions}`);
  else if (codes[400] === 60) ok('all 60 notification-init -> 400, zero sessions created');
  else note('MED', 'unexpected status mix', JSON.stringify(codes));
  await verifyToolsCall('after-seq-flood');
}

// ============ 2. PARALLEL notification-init x60 ============
console.log('\n== 2. notification-style initialize x60 (parallel burst) ==');
{
  const before = await status();
  const rs = await Promise.all(Array.from({ length: 60 }, () => post(NOTIFY_INIT)));
  const codes = {}; let leaked = 0;
  for (const r of rs) { codes[r.status] = (codes[r.status] || 0) + 1; if (r.sid) leaked++; }
  const after = await status();
  console.log(`  codes: ${JSON.stringify(codes)}  sessions: ${before.sessions} -> ${after.sessions}  leaked sids: ${leaked}`);
  if (leaked) note('CRITICAL', 'parallel notification-init leaked sessions', `${leaked} sids`);
  else if (after.sessions - before.sessions > 2) note('HIGH', 'parallel flood grew session map', `${before.sessions} -> ${after.sessions}`);
  else ok('parallel notification-init: no leak');
  await verifyToolsCall('after-parallel-flood');
}

// ============ 3. id-bypass variants ============
console.log('\n== 3. id-bypass variants (null / missing / batch-wrapped) ==');
{
  const before = await status();
  const variants = [
    ['id:null', { ...NOTIFY_INIT, id: null }],
    ['id omitted entirely', NOTIFY_INIT],
    ['batch [init-notify]', [NOTIFY_INIT]],
    ['batch [init-req, notif]', [INIT(1), { jsonrpc: '2.0', method: 'notifications/initialized' }]],
    ['init-notify + forged sid header', NOTIFY_INIT, { 'mcp-session-id': 'deadbeef-0000-0000-0000-000000000000' }],
  ];
  for (const [label, body, hdrs] of variants) {
    const r = await post(body, hdrs || {});
    const grew = r.sid ? ' SESSION-ID ISSUED' : '';
    if (r.sid) { note('HIGH', `${label} leaked a session`, `status ${r.status}`); await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': r.sid } }).catch(() => {}); }
    else ok(`${label} -> ${r.status}${grew} ${r.text.slice(0, 80)}`);
  }
  const after = await status();
  if (after.sessions - before.sessions > 0) note('HIGH', 'bypass variants grew session map', `${before.sessions} -> ${after.sessions}`);
}

// ============ 4. concurrent VALID initialize flood x30 ============
console.log('\n== 4. concurrent initialize flood (30 parallel, with ids) ==');
{
  const before = await status();
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => post(INIT(5000 + i))));
  const codes = {}; const sids = [];
  for (const r of rs) { codes[r.status] = (codes[r.status] || 0) + 1; if (r.sid) sids.push(r.sid); }
  const mid = await status();
  console.log(`  codes: ${JSON.stringify(codes)}  sids: ${sids.length}  sessions ${before.sessions} -> ${mid.sessions}`);
  if (sids.length !== 30 && !codes[503]) note('MED', 'flood: some inits failed without 503', JSON.stringify(codes));
  else ok(`flood: ${sids.length} sessions created${codes[503] ? `, ${codes[503]} correctly 503'd at cap` : ''}`);
  if (new Set(sids).size !== sids.length) note('HIGH', 'duplicate session ids issued under concurrency', `${sids.length - new Set(sids).size} dupes`);
  // hammer past the cap: keep initializing until 503 or +40 more
  let extra = 0, hit503 = 0; const extraSids = [];
  for (let i = 0; i < 40; i++) {
    const r = await post(INIT(6000 + i));
    if (r.status === 503) hit503++;
    else if (r.sid) { extraSids.push(r.sid); extra++; }
  }
  const after = await status();
  console.log(`  past-cap push: +${extra} sessions, ${hit503}x503, sessions now ${after.sessions}`);
  if (after.sessions > 50) note('HIGH', 'session cap MAX_SESSIONS=50 exceeded', `sessions=${after.sessions}`);
  else if (after.sessions >= 50 && hit503 === 0) note('MED', 'at cap but never saw 503', `sessions=${after.sessions}`);
  else ok(`cap enforced: sessions=${after.sessions}, 503s=${hit503}`);
  for (const s of [...sids, ...extraSids]) await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': s } }).catch(() => {});
  await verifyToolsCall('after-init-flood');
}

// ============ 5. initialize twice on same session ============
console.log('\n== 5. double initialize on same session ==');
{
  const r1 = await post(INIT(1));
  const sid = r1.sid;
  const r2 = await post(INIT(2), { 'mcp-session-id': sid });
  console.log(`  first init: ${r1.status} sid=${sid?.slice(0, 8)}  second init: ${r2.status} ${r2.text.slice(0, 150)}`);
  if (r2.status === 200 && /result/.test(r2.text)) note('MED', 'double initialize returned a second result', 'session re-initialized — spec expects error');
  else ok(`double init rejected: ${r2.status}`);
  const p = await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-session-id': sid });
  ok(`session usable after double-init: ping -> ${p.status} ${/result/.test(p.text) ? '(alive)' : '(DEAD?)'}`);
  await fetch(MCP, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => {});
}

// ============ survival ============
const end = await status();
console.log(`\nfinal bridge status: ${JSON.stringify(end)}`);
console.log(`===== adv-16 done: ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`${i + 1}. [${f.sev}] ${f.title} — ${f.detail}`));
