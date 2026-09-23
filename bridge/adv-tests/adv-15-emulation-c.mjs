// adv-15 part C: CPU, network persistence/recovery, unsupported params,
// non-atomic apply, stacking+headers, reset, persistence/leak/tab-close,
// chrome://, about:blank, bogus id, cleanup (incl. orphan 301370913).
const BASE = 'http://127.0.0.1:7890/mcp';
const PAGE = 'http://127.0.0.1:7890/';
let sid = null, nextId = 1;
const results = [];
const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv15c', version: '0' } };

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
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await rpcOnce(method, params);
      if (r && (r.status === 404 || r.status === 503) && method !== 'initialize') { sid = null; await rpcOnce('initialize', INIT); continue; }
      return r;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));
      sid = null;
      await rpcOnce('initialize', INIT).catch(() => {});
    }
  }
  return { fatal: 'transport dead after retries' };
}
const textOf = r => (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r).slice(0, 400);
const errOf = r => {
  if (r && r.fatal) return 'transport: ' + r.fatal;
  return (r && (r.isError || /^Error:/.test(textOf(r)))) ? textOf(r).replace(/\s+/g, ' ').slice(0, 160) : null;
};
async function call(name, args = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await rpc('tools/call', { name, arguments: args });
    const res = r.result ?? r;
    if (/extension call timeout|extension disconnected|extension not connected/i.test(textOf(res))) {
      await new Promise(x => setTimeout(x, 1500));
      continue;
    }
    return res;
  }
  return { isError: true, content: [{ type: 'text', text: 'Error: extension unreachable after retries' }] };
}
async function ev(pageId, fn) {
  const r = await call('evaluate_script', { pageId, function: fn });
  const e = errOf(r);
  if (e) return { __err: e };
  const s = r.structuredContent;
  return s && 'result' in s ? s.result : { __err: 'no structured result' };
}
const G = (o, k) => (o && typeof o === 'object' && !o.__err ? o[k] : undefined);
const num = v => (typeof v === 'number' ? v : 9e9);
function check(name, pass, evidence) {
  results.push({ name, pass: !!pass, evidence: String(evidence).slice(0, 240) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + evidence);
}
const FETCH1 = `async()=>{const s=performance.now();try{const r=await fetch('/?cb='+Math.random(),{cache:'no-store'});await r.text();return {ms:Math.round(performance.now()-s),status:r.status}}catch(e){return {err:String(e.message||e)}}}`;
const BENCH = `()=>{const t0=performance.now();let x=0;for(let i=0;i<2e6;i++)x+=Math.sqrt(i)*Math.sin(i);return Math.round(performance.now()-t0)}`;

await rpc('initialize', INIT);
const np = await call('new_page', { url: PAGE });
const T1 = np.structuredContent && np.structuredContent.pageId;
if (!T1) { console.log('FATAL: no test tab: ' + textOf(np)); process.exit(1); }
const myTabs = [T1, 301370913 /* orphan from part B */];
console.log('T1 =', T1);
await new Promise(r => setTimeout(r, 900));
const base = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent,mtp:navigator.maxTouchPoints,dark:matchMedia('(prefers-color-scheme: dark)').matches,tz:Intl.DateTimeFormat().resolvedOptions().timeZone})`);
console.log('baseline:', JSON.stringify(base));
const baseFetch = await ev(T1, FETCH1);
const baseMs = num(G(baseFetch, 'ms'));
console.log('baseline fetch ms:', baseMs);
async function emu(args) { const r = await call('emulate', { pageId: T1, ...args }); return { err: errOf(r), data: r.structuredContent }; }

// ================= CPU =================
await emu({ cpuThrottlingRate: 1 });
const b1 = Math.min(num(await ev(T1, BENCH)), num(await ev(T1, BENCH)));
let r = await emu({ cpuThrottlingRate: 4 });
const b4 = Math.min(num(await ev(T1, BENCH)), num(await ev(T1, BENCH)));
check('cpu 4x slows JS', !r.err && b4 > b1 * 1.8, `base=${b1}ms rate4=${b4}ms ratio=${(b4 / b1).toFixed(1)}`);
r = await emu({ cpuThrottlingRate: 20 });
const b20 = num(await ev(T1, BENCH));
check('cpu 20x slows further', !r.err && b20 > b1 * 3, `rate20=${b20 === 9e9 ? 'ERR' : b20}ms vs base=${b1}ms`);
await emu({ cpuThrottlingRate: 1 });
{
  const bx = num(await ev(T1, BENCH));
  check('cpu reset 1 restores', bx < b4 * 0.6, `reset=${bx === 9e9 ? 'ERR' : bx}ms vs rate4=${b4}ms`);
}
// fractional + weird
r = await emu({ cpuThrottlingRate: 0.5 });
check('cpu 0.5 rejected (<1)', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ cpuThrottlingRate: 1.5 });
check('cpu 1.5 fractional accepted', !r.err, r.err || JSON.stringify(r.data));

// ================= network persistence/recovery =================
r = await emu({ networkConditions: 'Offline' });
await ev(T1, FETCH1);
r = await emu({ networkConditions: 'bogus' });
{
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('Offline persists through rejected emulate call', onl === false, 'onLine=' + JSON.stringify(onl) + ' rejected-err=' + (r.err || 'none'));
}
r = await emu({ networkConditions: 'Fast 3G' });
{
  const f = await ev(T1, FETCH1);
  check('recovery Offline->Fast3G (preset swap works)', !r.err && G(f, 'status') === 200, 'fetch=' + JSON.stringify(f));
}
r = await emu({ latency: -1, downloadThroughput: 0, uploadThroughput: -5 });
check('custom latency/throughput args silently ignored', !r.err && r.data && Object.keys(r.data.applied || {}).length === 0,
  'err=' + (r.err || 'none') + ' applied=' + JSON.stringify(r.data && r.data.applied));
r = await emu({ timezoneId: 'Mars/Olympus', locale: 'xx-INVALID', prefersReducedMotion: 'reduce' });
{
  const p = await ev(T1, `()=>({tz:Intl.DateTimeFormat().resolvedOptions().timeZone,rm:matchMedia('(prefers-reduced-motion: reduce)').matches,lang:navigator.language})`);
  check('timezoneId/locale/reducedMotion all silently ignored',
    !r.err && G(p, 'tz') === base.tz && G(p, 'rm') === false,
    'applied=' + JSON.stringify(r.data && r.data.applied) + ' probe=' + JSON.stringify(p));
}
// non-atomic: earlier param applied, later throws
r = await emu({ networkConditions: 'Offline', viewport: 'bogus' });
{
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('NON-ATOMIC apply: error returned but Offline still applied', !!r.err && onl === false,
    'err=' + (r.err || 'none') + ' onLine=' + JSON.stringify(onl));
}
// stacked apply
r = await emu({ networkConditions: 'Fast 4G', cpuThrottlingRate: 2, viewport: '500x400x2,mobile,touch', colorScheme: 'dark', userAgent: 'ADV15-STACK', geolocation: '40.7,-74', extraHttpHeaders: '{"X-Adv15":"yes"}' });
{
  const p = await ev(T1, `()=>({sw:screen.width,dpr:Math.round(devicePixelRatio),dark:matchMedia('(prefers-color-scheme: dark)').matches,ua:navigator.userAgent,mtp:navigator.maxTouchPoints})`);
  check('stacked: viewport+UA+dark+cpu+geo+headers one call', !r.err && G(p, 'sw') === 500 && G(p, 'ua') === 'ADV15-STACK' && G(p, 'dark') === true && G(p, 'mtp') === 1,
    'err=' + (r.err || 'none') + ' ' + JSON.stringify(p));
}
{
  await ev(T1, FETCH1);
  const net = await call('list_network_requests', { pageId: T1, pageSize: 8 });
  const reqs = (net.structuredContent && net.structuredContent.requests) || [];
  const hit = reqs.filter(q => /x-adv15/i.test(JSON.stringify(q.requestHeaders || {})));
  check('extraHttpHeaders X-Adv15 present on outgoing request', hit.length > 0,
    'requests=' + reqs.length + ' withHeader=' + hit.length + ' last=' + JSON.stringify((reqs[reqs.length - 1] || {}).requestHeaders || {}).slice(0, 180));
}
// invalid extraHttpHeaders
r = await emu({ extraHttpHeaders: '{not json' });
check('extraHttpHeaders invalid JSON -> error', !!r.err, r.err || 'NONE');
r = await emu({ extraHttpHeaders: '{"X-Bad":"a\\nb"}' });
check('extraHttpHeaders value with newline', !!r.err, 'err=' + (r.err || 'NONE — newline header accepted'));

// full reset via tool (all but network), then detach for network
r = await emu({ viewport: '', cpuThrottlingRate: 1, geolocation: '', userAgent: '', colorScheme: 'auto', extraHttpHeaders: '', networkConditions: 'Fast 4G' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent,dark:matchMedia('(prefers-color-scheme: dark)').matches,mtp:navigator.maxTouchPoints})`);
  check('reset call reverts viewport/UA/color/touch', G(p, 'iw') === base.iw && G(p, 'ua') === base.ua && G(p, 'dark') === base.dark && G(p, 'mtp') === base.mtp,
    JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40), dark: G(p, 'dark'), mtp: G(p, 'mtp') }));
}
await call('detach_debugger', { pageId: T1 });
{
  const f = await ev(T1, FETCH1);
  check('detach_debugger clears remaining net emulation', num(G(f, 'ms')) < 400, 'fetch=' + JSON.stringify(f));
}

// ================= persistence =================
await emu({ viewport: '777x555x1', userAgent: 'NAVPERSIST-UA' });
await call('navigate_page', { pageId: T1, type: 'url', url: PAGE + '?nav=2' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('persists across navigation', G(p, 'iw') === 777 && G(p, 'ua') === 'NAVPERSIST-UA', JSON.stringify(p));
}
const np2 = await call('new_page', { url: PAGE, background: true });
const T2 = np2.structuredContent && np2.structuredContent.pageId;
if (T2) {
  myTabs.push(T2);
  await new Promise(r => setTimeout(r, 800));
  const p = await ev(T2, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('no leak to second tab', G(p, 'iw') !== 777 && G(p, 'ua') !== 'NAVPERSIST-UA', JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}
await call('detach_debugger', { pageId: T1 });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('detach mid-emulation reverts live tab', G(p, 'iw') === base.iw && G(p, 'ua') === base.ua, JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}
await emu({ viewport: '777x555x1', userAgent: 'NAVPERSIST-UA' });
await call('close_page', { pageId: T1 });
const np3 = await call('new_page', { url: PAGE });
const T3 = np3.structuredContent && np3.structuredContent.pageId;
if (T3) {
  myTabs.push(T3);
  await new Promise(r => setTimeout(r, 800));
  const p = await ev(T3, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('closing emulated tab -> new tab clean', G(p, 'iw') !== 777 && G(p, 'ua') !== 'NAVPERSIST-UA', JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}

// ================= chrome:// / about:blank / bogus =================
const npc = await call('new_page', { url: 'chrome://version/', background: true });
const TC = npc.structuredContent && npc.structuredContent.pageId;
if (TC) {
  myTabs.push(TC);
  await new Promise(r => setTimeout(r, 600));
  const rc = await call('emulate', { pageId: TC, cpuThrottlingRate: 2 });
  check('emulate on chrome:// -> clean error', !!errOf(rc), errOf(rc) || JSON.stringify(rc.structuredContent));
} else {
  check('emulate on chrome:// (new_page refused)', true, 'new_page: ' + textOf(npc).slice(0, 120));
}
const npb = await call('new_page', { url: 'about:blank', background: true });
const TB = npb.structuredContent && npb.structuredContent.pageId;
if (TB) {
  myTabs.push(TB);
  await new Promise(r => setTimeout(r, 600));
  const rb = await call('emulate', { pageId: TB, cpuThrottlingRate: 2, viewport: '333x333x1' });
  const ebb = await ev(TB, `()=>innerWidth`);
  check('emulate on about:blank applies (scripting still unreachable)',
    !errOf(rb) && ebb && ebb.__err, 'emulate=' + (errOf(rb) || JSON.stringify(rb.structuredContent)) + ' eval=' + JSON.stringify(ebb).slice(0, 130));
}
{
  const rx = await call('emulate', { pageId: 99999999, cpuThrottlingRate: 2 });
  check('emulate bogus pageId -> clean error', !!errOf(rx), errOf(rx) || 'NONE');
}
{
  const anyT = T3 || T2;
  const rz = await call('emulate', { pageId: anyT });
  check('emulate no params -> no-op success', !errOf(rz), 'applied=' + JSON.stringify(rz.structuredContent));
}

// ================= cleanup =================
for (const t of myTabs) {
  if (!t) continue;
  await call('emulate', { pageId: t, viewport: '', cpuThrottlingRate: 1, userAgent: '', colorScheme: 'auto', geolocation: '', extraHttpHeaders: '' }).catch(() => {});
  await call('detach_debugger', { pageId: t }).catch(() => {});
  await call('close_page', { pageId: t }).catch(() => {});
}
const pass = results.filter(x => x.pass).length, fail = results.filter(x => !x.pass).length;
console.log('\n===== PART C SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
for (const x of results.filter(x => !x.pass)) console.log('  FAIL: ' + x.name + ' -- ' + x.evidence);
