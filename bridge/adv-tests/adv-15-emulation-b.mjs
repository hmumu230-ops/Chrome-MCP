// adv-15 part B: retests + persistence + chrome:// + hardening for bridge deaths.
const BASE = 'http://127.0.0.1:7890/mcp';
const PAGE = 'http://127.0.0.1:7890/';
let sid = null, nextId = 1;
const results = [];

const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv15b', version: '0' } };
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
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await rpcOnce(method, params);
      if (r && r.status === 404 && method !== 'initialize') { sid = null; await rpcOnce('initialize', INIT); continue; }
      return r;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1200));
      sid = null;
      await rpcOnce('initialize', INIT).catch(() => {});
    }
  }
  return { fatal: 'transport dead after retries' };
}
async function call(name, args = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await rpc('tools/call', { name, arguments: args });
    const res = r.result ?? r;
    const t = textOf(res);
    if (/extension call timeout|extension disconnected|extension not connected/i.test(t)) {
      await new Promise(x => setTimeout(x, 1500));
      continue;
    }
    return res;
  }
  return { isError: true, content: [{ type: 'text', text: 'Error: extension unreachable after retries' }] };
}
const textOf = r => (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r).slice(0, 400);
const errOf = r => {
  if (r && r.fatal) return 'transport: ' + r.fatal;
  return (r && (r.isError || /^Error:/.test(textOf(r)))) ? textOf(r).replace(/\s+/g, ' ').slice(0, 160) : null;
};
async function ev(pageId, fn) {
  const r = await call('evaluate_script', { pageId, function: fn });
  const e = errOf(r);
  if (e) return { __err: e };
  const s = r.structuredContent;
  return s && 'result' in s ? s.result : { __err: 'no structured result' };
}
const G = (o, k) => (o && typeof o === 'object' && !o.__err ? o[k] : undefined);
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
const myTabs = [T1];
console.log('T1 =', T1);
await new Promise(r => setTimeout(r, 900));
const base = await ev(T1, `()=>({iw:innerWidth,dpr:devicePixelRatio,ua:navigator.userAgent,mtp:navigator.maxTouchPoints,dark:matchMedia('(prefers-color-scheme: dark)').matches,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,sw:screen.width,sh:screen.height})`);
console.log('baseline:', JSON.stringify(base));
const baseFetch = await ev(T1, FETCH1);
const baseMs = G(baseFetch, 'ms') || 10;

async function emu(args) { const r = await call('emulate', { pageId: T1, ...args }); return { err: errOf(r), data: r.structuredContent }; }

// ---- retest: 0x0 viewport semantics ----
let r = await emu({ viewport: '0x0x2' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,vv:visualViewport.width})`);
  check('0x0x2: accepted silently; dims ignored but dpr applied',
    !r.err && G(p, 'dpr') === 2 && G(p, 'iw') === base.iw,
    'err=' + (r.err || 'none') + ' probe=' + JSON.stringify(p));
}
// ---- iPhone-like with proper probes (screen.width = emulated device px) ----
r = await emu({ viewport: '390x844x3,mobile,touch', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,sw:screen.width,sh:screen.height,dpr:devicePixelRatio,mtp:navigator.maxTouchPoints,ua:navigator.userAgent.slice(0,50),vvw:visualViewport.width})`);
  check('iPhone-like: screen.width=390, mtp=1, UA=iPhone (innerWidth=980 = no-meta mobile fallback)',
    !r.err && G(p, 'sw') === 390 && G(p, 'mtp') === 1 && /iPhone/.test(G(p, 'ua')),
    JSON.stringify(p));
}
// ---- landscape flag: does screen.orientation flip? ----
r = await emu({ viewport: '844x390x3,mobile,touch,landscape' });
{
  const p1 = await ev(T1, `()=>({orient:screen.orientation.type,angle:screen.orientation.angle,sw:screen.width,sh:screen.height})`);
  await call('navigate_page', { pageId: T1, type: 'url', url: PAGE + '?land=1' });
  const p2 = await ev(T1, `()=>({orient:screen.orientation.type,angle:screen.orientation.angle,sw:screen.width,sh:screen.height})`);
  check('landscape flag flips screen.orientation', /landscape/.test(G(p2, 'orient') || ''),
    'before-nav=' + JSON.stringify(p1) + ' after-nav=' + JSON.stringify(p2));
}
// ---- touch leak confirm (mtp stays 1 on touch-capable machine, baseline 10) ----
r = await emu({ viewport: '800x600x1' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,mtp:navigator.maxTouchPoints})`);
  check('touch leak: viewport re-set w/o ,touch keeps mtp=1', G(p, 'mtp') === 1 && G(p, 'iw') === 800,
    JSON.stringify(p) + ' baseline mtp=' + base.mtp);
}
r = await emu({ viewport: '' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,mtp:navigator.maxTouchPoints,dpr:devicePixelRatio})`);
  check('viewport "" clears metrics+touch to baseline', G(p, 'iw') === base.iw && G(p, 'mtp') === base.mtp,
    JSON.stringify(p) + ' baseline=' + JSON.stringify({ iw: base.iw, mtp: base.mtp }));
}
await emu({ userAgent: '' });

// ---- CPU throttle (retry-friendly, min of 2) ----
await emu({ cpuThrottlingRate: 1 });
const b1a = await ev(T1, BENCH), b1b = await ev(T1, BENCH);
const b1 = Math.min(G(b1a, 'result' in (b1a || {}) ? 'x' : 'y') ? 0 : (typeof b1a === 'number' ? b1a : 9e9), typeof b1b === 'number' ? b1b : 9e9);
r = await emu({ cpuThrottlingRate: 4 });
const b4a = await ev(T1, BENCH), b4b = await ev(T1, BENCH);
const b4 = Math.min(typeof b4a === 'number' ? b4a : 9e9, typeof b4b === 'number' ? b4b : 9e9);
check('cpu 4x slows JS ~4x', b4 > b1 * 1.8, `base(min2)=${b1}ms rate4(min2)=${b4}ms`);
r = await emu({ cpuThrottlingRate: 20 });
const b20 = await ev(T1, BENCH);
check('cpu 20x slows further', typeof b20 === 'number' && b20 > b4 * 1.5, `rate20=${JSON.stringify(b20)}ms`);
await emu({ cpuThrottlingRate: 1 });
{
  const bx = await ev(T1, BENCH);
  check('cpu reset to 1 restores', typeof bx === 'number' && bx < b4 * 0.6, `reset=${JSON.stringify(bx)}ms vs rate4=${b4}ms`);
}

// ---- network: persistence + recovery ----
r = await emu({ networkConditions: 'Offline' });
await ev(T1, FETCH1);
r = await emu({ networkConditions: 'bogus' }); // rejected call
{
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('Offline persists through a rejected emulate call', onl === false, 'onLine=' + JSON.stringify(onl));
}
r = await emu({ networkConditions: 'Fast 3G' });
{
  const f = await ev(T1, FETCH1);
  check('recovery Offline -> Fast 3G', !r.err && G(f, 'ms') > 0 && G(f, 'status') === 200, 'fetch=' + JSON.stringify(f));
}
// custom latency/throughput params — silent ignore?
r = await emu({ latency: -1, downloadThroughput: 0 });
check('unknown args (latency/throughput) silently ignored, success reported',
  !r.err && r.data && Object.keys(r.data.applied || {}).length === 0,
  'err=' + (r.err || 'none') + ' applied=' + JSON.stringify(r.data && r.data.applied));
// unsupported timezone/locale again (bridge was dead during part A)
r = await emu({ timezoneId: 'Mars/Olympus', locale: 'xx-INVALID' });
{
  const tz = await ev(T1, `()=>Intl.DateTimeFormat().resolvedOptions().timeZone`);
  check('timezoneId/locale silently ignored (not implemented)',
    !r.err && tz === base.tz, 'applied=' + JSON.stringify(r.data && r.data.applied) + ' tz=' + JSON.stringify(tz));
}
// ---- non-atomic partial application ----
await emu({ networkConditions: 'Fast 4G' });
r = await emu({ networkConditions: 'Offline', viewport: 'bogus' });
{
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('NON-ATOMIC: error returned but earlier param (Offline) still applied',
    !!r.err && onl === false, 'err=' + (r.err || 'none') + ' onLine=' + JSON.stringify(onl));
}
// ---- stacked apply + extraHttpHeaders verification ----
r = await emu({ networkConditions: 'Fast 4G', cpuThrottlingRate: 2, viewport: '500x400x2,mobile,touch', colorScheme: 'dark', userAgent: 'ADV15-STACK', geolocation: '40.7,-74', extraHttpHeaders: '{"X-Adv15":"yes"}' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,dpr:devicePixelRatio,dark:matchMedia('(prefers-color-scheme: dark)').matches,ua:navigator.userAgent,mtp:navigator.maxTouchPoints,sw:screen.width})`);
  check('stacked apply: viewport+UA+dark+cpu+geo+headers in one call',
    !r.err && G(p, 'sw') === 500 && G(p, 'ua') === 'ADV15-STACK' && G(p, 'dark') === true && G(p, 'mtp') === 1,
    JSON.stringify(p));
}
{
  await ev(T1, FETCH1);
  const net = await call('list_network_requests', { pageId: T1, pageSize: 5 });
  const reqs = (net.structuredContent && net.structuredContent.requests) || [];
  const hdrHit = reqs.some(q => /x-adv15/i.test(JSON.stringify(q.requestHeaders || {})));
  check('extraHttpHeaders X-Adv15 observed in recorded request', hdrHit,
    'reqs=' + reqs.length + ' last=' + JSON.stringify((reqs[reqs.length - 1] || {}).requestHeaders || {}).slice(0, 200));
}
// ---- full reset via tool (all but network) ----
r = await emu({ viewport: '', cpuThrottlingRate: 1, geolocation: '', userAgent: '', colorScheme: 'auto', extraHttpHeaders: '', networkConditions: 'Fast 4G' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent,dark:matchMedia('(prefers-color-scheme: dark)').matches,mtp:navigator.maxTouchPoints,dpr:devicePixelRatio})`);
  check('reset reverts viewport/UA/color/touch', G(p, 'iw') === base.iw && G(p, 'ua') === base.ua && G(p, 'dark') === base.dark && G(p, 'mtp') === base.mtp,
    JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40), dark: G(p, 'dark'), mtp: G(p, 'mtp') }));
}
// detach clears remaining network override
await call('detach_debugger', { pageId: T1 });
{
  const f = await ev(T1, FETCH1);
  check('detach_debugger clears all emulation (only network reset path)', typeof G(f, 'ms') === 'number' && G(f, 'ms') < 300,
    'fetch=' + JSON.stringify(f));
}

// ================= F. persistence =================
await emu({ viewport: '777x555x1', userAgent: 'NAVPERSIST-UA' });
await call('navigate_page', { pageId: T1, type: 'url', url: PAGE + '?nav=2' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('emulation persists across navigation', G(p, 'iw') === 777 && G(p, 'ua') === 'NAVPERSIST-UA', JSON.stringify(p));
}
const np2 = await call('new_page', { url: PAGE, background: true });
const T2 = np2.structuredContent && np2.structuredContent.pageId;
if (T2) {
  myTabs.push(T2);
  await new Promise(r => setTimeout(r, 800));
  const p = await ev(T2, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('no leak to second tab', G(p, 'iw') !== 777 && G(p, 'ua') !== 'NAVPERSIST-UA', JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}
// detach while emulated then re-eval same tab — overrides gone?
await call('detach_debugger', { pageId: T1 });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('detach mid-emulation reverts live tab', G(p, 'iw') === base.iw && G(p, 'ua') === base.ua,
    JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}
// re-emulate, close tab, open fresh
await emu({ viewport: '777x555x1', userAgent: 'NAVPERSIST-UA' });
await call('close_page', { pageId: T1 });
const np3 = await call('new_page', { url: PAGE });
const T3 = np3.structuredContent && np3.structuredContent.pageId;
if (T3) {
  myTabs.push(T3);
  await new Promise(r => setTimeout(r, 800));
  const p = await ev(T3, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('closed emulated tab: new tab clean', G(p, 'iw') !== 777 && G(p, 'ua') !== 'NAVPERSIST-UA',
    JSON.stringify({ iw: G(p, 'iw'), ua: String(G(p, 'ua')).slice(0, 40) }));
}

// ================= G. chrome:// / about:blank / bogus =================
const npc = await call('new_page', { url: 'chrome://version/', background: true });
const TC = npc.structuredContent && npc.structuredContent.pageId;
if (TC) {
  myTabs.push(TC);
  await new Promise(r => setTimeout(r, 600));
  const rc = await call('emulate', { pageId: TC, cpuThrottlingRate: 2 });
  check('emulate on chrome:// -> clean error', !!errOf(rc), errOf(rc) || JSON.stringify(rc.structuredContent));
} else {
  check('emulate on chrome:// -> clean error', true, 'new_page refused chrome://: ' + textOf(npc).slice(0, 120));
}
const npb = await call('new_page', { url: 'about:blank', background: true });
const TB = npb.structuredContent && npb.structuredContent.pageId;
if (TB) {
  myTabs.push(TB);
  await new Promise(r => setTimeout(r, 600));
  const rb = await call('emulate', { pageId: TB, cpuThrottlingRate: 2, viewport: '333x333x1' });
  const eb = await ev(TB, `()=>innerWidth`);
  check('emulate on about:blank', !errOf(rb), 'emulate=' + (errOf(rb) || JSON.stringify(rb.structuredContent)) + ' evalInnerWidth=' + JSON.stringify(eb).slice(0, 140));
}
{
  const rx = await call('emulate', { pageId: 99999999, cpuThrottlingRate: 2 });
  check('emulate bogus pageId -> clean error', !!errOf(rx), errOf(rx) || 'NONE');
}
// emulate with zero args
{
  const rz = await call('emulate', { pageId: T2 || T3 });
  check('emulate with no params -> no-op success', !errOf(rz), 'applied=' + JSON.stringify(rz.structuredContent));
}

// ================= cleanup =================
for (const t of myTabs) {
  if (!t) continue;
  await call('emulate', { pageId: t, viewport: '', cpuThrottlingRate: 1, userAgent: '', colorScheme: 'auto', geolocation: '', extraHttpHeaders: '' }).catch(() => {});
  await call('detach_debugger', { pageId: t }).catch(() => {});
  await call('close_page', { pageId: t }).catch(() => {});
}

const pass = results.filter(x => x.pass).length, fail = results.filter(x => !x.pass).length;
console.log('\n===== PART B SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
for (const x of results.filter(x => !x.pass)) console.log('  FAIL: ' + x.name + ' -- ' + x.evidence);
