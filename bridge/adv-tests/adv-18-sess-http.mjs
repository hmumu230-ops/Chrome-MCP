// adv-18-sess-http.mjs — session lifecycle abuse + Streamable-HTTP specifics.
// forged mcp-session-id headers, DELETE-then-reuse, Accept header games,
// GET /mcp SSE streams, Last-Event-ID replay, SSE abuse.
// Run on Windows node: node adv-18-sess-http.mjs
const MCP = 'http://127.0.0.1:7890/mcp';
const ROOT = 'http://127.0.0.1:7890/';
const T = 10000;
const findings = [];
const note = (sev, title, detail) => { findings.push({ sev, title, detail }); console.log(`  [${sev}] ${title} :: ${detail}`); };
const ok = (m) => console.log(`  PASS ${m}`);

const INIT = (id) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv18', version: '0.1' } },
});
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

async function req(method, { body, headers = {}, rawBody, timeout = T } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(MCP, {
      method, signal: ac.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: method === 'GET' || method === 'HEAD' ? undefined : (rawBody !== undefined ? rawBody : JSON.stringify(body)),
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers, sid: r.headers.get('mcp-session-id') };
  } catch (e) { return { status: -1, text: `FETCH-ERR ${e.name}: ${e.message}`, headers: new Headers() }; }
  finally { clearTimeout(t); }
}
const post = (b, h) => req('POST', { body: b, headers: h });
const sidHdr = (s, extra = {}) => ({ 'mcp-session-id': s, ...extra });
const alive = async () => { try { const s = JSON.parse(await (await fetch(ROOT)).text()); return s; } catch (e) { return { err: e.message }; } };

// get two live sessions A and B
const rA = await post(INIT(1));
const sidA = rA.sid;
const rB = await post(INIT(2));
const sidB = rB.sid;
const created = [sidA, sidB].filter(Boolean);
console.log(`session A: ${sidA?.slice(0, 8)}  session B: ${sidB?.slice(0, 8)}`);
if (!sidA || !sidB) { console.log('FATAL: init failed'); process.exit(1); }

// ============ A. forged mcp-session-id headers ============
console.log('\n== A. forged mcp-session-id headers ==');
{
  const forgeries = [
    ['random uuid', crypto.randomUUID()],
    ['empty string', ''],
    ['whitespace', '   '],
    ['not-a-uuid', 'forged-not-a-uuid'],
    ['uuid-like wrong', '00000000-0000-0000-0000-000000000000'],
    ['A + suffix', sidA + 'ZZ'],
    ['A truncated', sidA.slice(0, -1)],
    ['A uppercased', sidA.toUpperCase()],
    ['A with null byte', sidA + '\u0000'],
    ['__proto__', '__proto__'],
    ['SQL-ish', "' OR 1=1 --"],
    ['CRLF attempt', 'abc\r\nX-Injected: yes'],
    ['4KB sid', 'F'.repeat(4096)],
    ['json in sid', '{"$gt":""}'],
  ];
  for (const [label, f] of forgeries) {
    let r;
    try { r = await post(PING, sidHdr(f)); }
    catch (e) { ok(`forged ${label}: client-side reject (${e.message.slice(0, 60)})`); continue; }
    if (r.status === 404) ok(`forged ${label} -> 404`);
    else if (r.status === 200) note('CRITICAL', `forged sid accepted: ${label}`, `sid=${JSON.stringify(String(f).slice(0, 40))} got 200 — session fixation/hijack`);
    else note('MED', `forged ${label} -> ${r.status}`, r.text.slice(0, 120));
  }
  // session swap: session A's id used while B is "the client" — bearer-token model
  const swap = await post({ jsonrpc: '2.0', id: 9, method: 'ping' }, sidHdr(sidA));
  if (swap.status === 200) note('LOW', 'session id = bearer capability', 'any local process that learns the UUID can drive the session (no binding). spec-allowed.');
  // duplicate session headers (Node joins with comma)
  const dup = await req('POST', { body: PING, headers: { 'mcp-session-id': `${sidA}, ${sidB}` } });
  ok(`two sids in one header -> ${dup.status} ${dup.text.slice(0, 80)}`);
}

// ============ B. DELETE then reuse ============
console.log('\n== B. DELETE session then reuse ==');
{
  const dead = await post(INIT(3));
  const deadSid = dead.sid; created.push(deadSid);
  const d1 = await req('DELETE', { headers: sidHdr(deadSid) });
  ok(`DELETE -> ${d1.status} ${d1.text.slice(0, 60)}`);
  const p1 = await post(PING, sidHdr(deadSid));
  if (p1.status === 404) ok('POST on deleted sid -> 404');
  else note('HIGH', `deleted session still answers POST: ${p1.status}`, p1.text.slice(0, 150));
  const g1 = await req('GET', { headers: sidHdr(deadSid) });
  ok(`GET on deleted sid -> ${g1.status}`);
  const d2 = await req('DELETE', { headers: sidHdr(deadSid) });
  ok(`re-DELETE -> ${d2.status}`);
  // race: DELETE then immediately POST in parallel — does the dead transport still serve?
  const [d3, p3] = await Promise.all([
    req('DELETE', { headers: sidHdr(sidB) }),
    post(PING, sidHdr(sidB)),
  ]);
  console.log(`  race DELETE+POST on B: delete=${d3.status} post=${p3.status}`);
  if (p3.status === 200) note('LOW', 'DELETE/POST race: in-flight POST still served', 'acceptable — connection-level race, no state corruption');
  const p4 = await post(PING, sidHdr(sidB));
  ok(`B after raced DELETE -> ${p4.status} (should be 404)`);
}

// ============ C. Accept header games on POST ============
console.log('\n== C. Accept header games ==');
{
  const acceptCases = [
    ['missing Accept', {}],
    ['Accept: application/json only', { accept: 'application/json' }],
    ['Accept: text/event-stream only', { accept: 'text/event-stream' }],
    ['Accept: text/plain', { accept: 'text/plain' }],
    ['Accept: */*', { accept: '*/*' }],
    ['Accept: empty', { accept: '' }],
    ['Accept: json,sse,extra', { accept: 'application/json, text/event-stream, application/xml' }],
    ['Accept: case variants', { accept: 'Application/JSON, Text/Event-Stream' }],
    ['Accept: q-values', { accept: 'application/json;q=0.9, text/event-stream;q=0.1' }],
  ];
  for (const [label, h] of acceptCases) {
    const hdrs = { 'content-type': 'application/json', 'mcp-session-id': sidA, ...h };
    if (label === 'missing Accept') delete hdrs.accept;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), T);
    try {
      const r = await fetch(MCP, { method: 'POST', headers: hdrs, body: JSON.stringify(PING), signal: ac.signal });
      const text = await r.text();
      const ct = r.headers.get('content-type') || '';
      console.log(`  ${label} -> ${r.status} ct=${ct.slice(0, 40)} body=${text.slice(0, 90).replace(/\n/g, '|')}`);
      if (r.status === -1) note('HIGH', `${label}: hung/failed`, '');
    } catch (e) {
      if (e.name === 'AbortError') ok(`${label} -> SSE stream held open (timeout=stream)`);
      else note('MED', `${label}: ${e.message}`, '');
    } finally { clearTimeout(t); }
  }
  // initialize with json-only accept — must the server refuse?
  const r5 = await req('POST', { body: INIT(4), headers: { accept: 'application/json' } });
  const s5 = r5.sid;
  if (s5) created.push(s5);
  note(r5.status === 200 && s5 ? 'MED' : 'LOW', `initialize with Accept: json-only -> ${r5.status}${s5 ? ' SESSION CREATED' : ''}`,
    s5 ? 'spec requires client to accept SSE; session created anyway — minor spec deviation' : r5.text.slice(0, 100));
}

// ============ D. GET /mcp ============
console.log('\n== D. GET /mcp (SSE stream) ==');
{
  // no session
  const g0 = await req('GET', { headers: {} });
  ok(`GET no session -> ${g0.status} ${g0.text.slice(0, 60)}`);
  // forged session
  const g1 = await req('GET', { headers: sidHdr('forged-uuid-0000') });
  ok(`GET forged session -> ${g1.status}`);
  // valid session, SSE accept
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2500);
  try {
    const r = await fetch(MCP, { method: 'GET', headers: { 'mcp-session-id': sidA, accept: 'text/event-stream' }, signal: ac.signal });
    const ct = r.headers.get('content-type');
    if (r.status === 200 && ct?.includes('event-stream')) {
      ok(`GET session -> 200 SSE (${ct})`);
      // stream stays open — abort
      ac.abort();
    } else {
      console.log(`  GET session -> ${r.status} ${ct} ${(await r.text().catch(() => '')).slice(0, 100)}`);
    }
  } catch (e) {
    if (e.name === 'AbortError') ok('GET SSE stream held open (correct), aborted');
    else note('MED', 'GET SSE error', e.message);
  } finally { clearTimeout(t); }
  // GET without event-stream accept
  const g2 = await req('GET', { headers: { 'mcp-session-id': sidA, accept: 'application/json' } });
  ok(`GET session, json-only accept -> ${g2.status} ${g2.text.slice(0, 60)}`);
}

// ============ E. SSE stream abuse ============
console.log('\n== E. SSE stream abuse ==');
{
  // open 20 concurrent GET streams on one session
  const controllers = [];
  let opened = 0, errored = 0;
  for (let i = 0; i < 20; i++) {
    const ac = new AbortController(); controllers.push(ac);
    fetch(MCP, { method: 'GET', headers: { 'mcp-session-id': sidA, accept: 'text/event-stream' }, signal: ac.signal })
      .then(r => { if (r.status === 200) opened++; })
      .catch(() => { errored++; });
  }
  await new Promise(r => setTimeout(r, 1500));
  console.log(`  20 concurrent SSE streams: opened=${opened} errored=${errored}`);
  if (opened >= 20) note('LOW', 'unbounded SSE streams per session', '20 streams opened; no per-session stream cap — slowloris-ish resource use');
  // while streams open, does normal POST still work?
  const p = await post(PING, sidHdr(sidA));
  ok(`POST while 20 SSE open -> ${p.status}`);
  // ping should be pushed to streams? abort all
  for (const ac of controllers) ac.abort();
  await new Promise(r => setTimeout(r, 300));
  // DELETE session while SSE stream open
  const ac2 = new AbortController();
  const streamP = fetch(MCP, { method: 'GET', headers: { 'mcp-session-id': sidA, accept: 'text/event-stream' }, signal: ac2.signal })
    .then(async r => ({ status: r.status, body: await r.text().catch(() => '') })).catch(e => ({ status: -1, body: e.name }));
  await new Promise(r => setTimeout(r, 400));
  const dR = await req('DELETE', { headers: sidHdr(sidA) });
  const sRes = await Promise.race([streamP, new Promise(r => setTimeout(() => r({ status: 'still-open' }), 2000))]);
  console.log(`  DELETE while SSE open: delete=${dR.status}, stream=${JSON.stringify(sRes).slice(0, 120)}`);
  ac2.abort();
  // recreate sidA (it may have been deleted)
  const rA2 = await post(INIT(10));
  if (rA2.sid) { created.push(rA2.sid); console.log(`  session A recreated: ${rA2.sid.slice(0, 8)}`); }
  else note('HIGH', 'cannot create new session after SSE-abuse phase', `${rA2.status} ${rA2.text.slice(0, 100)}`);
}

// ============ F. Last-Event-ID replay ============
console.log('\n== F. Last-Event-ID replay ==');
{
  const liveSid = created[created.length - 1];
  const cases = [
    ['LEI arbitrary "999"', '999'],
    ['LEI forged uuid', crypto.randomUUID()],
    ['LEI empty', ''],
    ['LEI huge', '9'.repeat(4096)],
    ['LEI injected CRLF', '1\r\nX-Bad: 1'],
    ['LEI negative', '-1'],
  ];
  for (const [label, lei] of cases) {
    let r;
    try { r = await post(PING, { 'mcp-session-id': liveSid, 'last-event-id': lei }); }
    catch (e) { ok(`${label}: client reject ${e.message.slice(0, 50)}`); continue; }
    if (r.status === -1) { note('MED', `${label}: fetch err`, r.text); continue; }
    ok(`${label} -> ${r.status} ${r.text.slice(0, 80).replace(/\n/g, '|')}`);
    if (/X-Bad/.test(r.text)) note('HIGH', 'CRLF injection reflected', r.text.slice(0, 150));
  }
  // GET stream with Last-Event-ID (resumability attempt)
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(MCP, { method: 'GET', headers: { 'mcp-session-id': liveSid, accept: 'text/event-stream', 'last-event-id': '0' }, signal: ac.signal });
    console.log(`  GET + Last-Event-ID:0 -> ${r.status} ${r.headers.get('content-type')}`);
    ac.abort();
  } catch (e) { if (e.name === 'AbortError') ok('GET+LEI stream opened (replay accepted silently)'); }
  finally { clearTimeout(t); }
}

// ============ G. misc HTTP ============
console.log('\n== G. misc HTTP methods ==');
{
  for (const m of ['PUT', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE']) {
    const r = await req(m, { headers: sidHdr(created[created.length - 1]), body: m === 'PUT' || m === 'PATCH' ? PING : undefined });
    ok(`${m} /mcp -> ${r.status}`);
  }
  // session id in URL query (should NOT work — header only)
  const r = await fetch(MCP + '?mcp-session-id=' + created[created.length - 1], {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(PING),
  });
  ok(`sid via query param -> ${r.status} (header-only auth is correct if 404)`);
  // content-type games
  const ct = await req('POST', { body: PING, headers: { ...sidHdr(created[created.length - 1]), 'content-type': 'text/plain' } });
  ok(`POST content-type text/plain -> ${ct.status}`);
  const ct2 = await req('POST', { rawBody: JSON.stringify(PING), headers: { ...sidHdr(created[created.length - 1]), 'content-type': '' } });
  ok(`POST no content-type -> ${ct2.status}`);
}

// ============ survival ============
const end = await alive();
console.log(`\nfinal: ${JSON.stringify(end)}`);
if (end.err) note('CRITICAL', 'bridge down at end', end.err);
for (const s of created) { try { await req('DELETE', { headers: sidHdr(s) }); } catch {} }
console.log(`===== adv-18 done: ${findings.length} findings =====`);
findings.forEach((f, i) => console.log(`${i + 1}. [${f.sev}] ${f.title} — ${f.detail}`));
