// adv-15: emulation edge cases. Drives http://127.0.0.1:7890/mcp directly.
// Test tabs navigate to the bridge's own GET / status endpoint (loopback JSON)
// so fetch latency probes need no internet and no mixed-content risk.
const BASE = 'http://127.0.0.1:7890/mcp';
const PAGE = 'http://127.0.0.1:7890/';
let sid = null, nextId = 1;
const results = [];

const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv15', version: '0' } };
async function rpcOnce(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  const ns = res.headers.get('mcp-session-id'); if (ns) sid = ns;
  const t = await res.text();
  const dl = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dl || t); } catch { return { raw: t.slice(0, 300), status: res.status }; }
}
async function rpc(method, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await rpcOnce(method, params);
      if (r && r.status === 404 && method !== 'initialize') { sid = null; await rpcOnce('initialize', INIT); continue; }
      return r;
    } catch (e) {
      if (attempt === 2) return { fatal: String(e && e.message || e) };
      await new Promise(r => setTimeout(r, 700));
      sid = null;
      await rpcOnce('initialize', INIT).catch(() => {});
    }
  }
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.result ?? r;
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
  return s && 'result' in s ? s.result : undefined;
}
function check(name, pass, evidence) {
  results.push({ name, pass: !!pass, evidence: String(evidence).slice(0, 220) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + evidence);
}
const PROBE = `()=>({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,ua:navigator.userAgent.slice(0,80),touch:'ontouchstart' in window,mtp:navigator.maxTouchPoints,onLine:navigator.onLine,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,lang:navigator.language,dark:matchMedia('(prefers-color-scheme: dark)').matches,rm:matchMedia('(prefers-reduced-motion: reduce)').matches,orient:screen.orientation&&screen.orientation.type,mobMeta:navigator.userAgentData?navigator.userAgentData.mobile:null})`;
const FETCH3 = `async()=>{const t=[];for(let i=0;i<3;i++){const s=performance.now();try{const r=await fetch('/?cb='+Math.random(),{cache:'no-store'});await r.text();t.push(Math.round(performance.now()-s))}catch(e){t.push('ERR:'+e.message)}}return t}`;
const FETCH1 = `async()=>{const s=performance.now();try{const r=await fetch('/?cb='+Math.random(),{cache:'no-store'});await r.text();return {ms:Math.round(performance.now()-s),status:r.status}}catch(e){return {err:String(e.message||e)}}}`;
const BENCH = `()=>{const t0=performance.now();let x=0;for(let i=0;i<3e6;i++)x+=Math.sqrt(i)*Math.sin(i);return Math.round(performance.now()-t0)}`;

const init = await rpc('initialize', INIT);
if (init.error || init.fatal) { console.log('INIT FAIL', JSON.stringify(init.error || init.fatal)); process.exit(1); }

const lp = await call('list_pages');
const pages0 = (lp.structuredContent && (lp.structuredContent.items || lp.structuredContent)) || [];
const myTabs = [];
console.log('existing tabs:', Array.isArray(pages0) ? pages0.length : '?');

// ---------- setup: test tab on loopback status page ----------
const np = await call('new_page', { url: PAGE, background: false });
const T1 = np.structuredContent && np.structuredContent.pageId;
if (!T1) { console.log('FATAL: could not open test tab:', textOf(np)); process.exit(1); }
myTabs.push(T1);
console.log('test tab T1 =', T1);
await new Promise(r => setTimeout(r, 800));

const base = await ev(T1, PROBE);
console.log('baseline probe:', JSON.stringify(base));
const baseFetch = await ev(T1, FETCH3);
console.log('baseline fetch ms:', JSON.stringify(baseFetch));
const baseMs = Array.isArray(baseFetch) ? Math.min(...baseFetch.filter(x => typeof x === 'number')) : 999;
check('baseline: loopback fetch reachable', baseMs < 900, 'min=' + baseMs + 'ms ' + JSON.stringify(baseFetch));

// ================= A. viewport bounds =================
async function emu(args) { const r = await call('emulate', { pageId: T1, ...args }); return { err: errOf(r), data: r.structuredContent }; }

let r;
r = await emu({ viewport: '-1x800x1' });
check('viewport width=-1 rejected', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ viewport: 'abcx800x1' });
check("viewport width='abc' rejected", !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ viewport: '0x0x1' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ih:innerHeight})`);
  check('viewport 0x0x1', !!r.err || (p && p.iw === 0), 'err=' + (r.err || 'none') + ' probe=' + JSON.stringify(p) + '  <-- regex \\d+ allows 0');
  await emu({ viewport: '' });
}
r = await emu({ viewport: '99999x99999x1' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ih:innerHeight})`);
  check('viewport 99999 clamped to 16384', !r.err && p.iw === 16384, 'err=' + (r.err || 'none') + ' probe=' + JSON.stringify(p));
  await emu({ viewport: '' });
}
r = await emu({ viewport: '800x600x0' });
check('dpr=0 rejected', !!r.err && /dpr/i.test(r.err), r.err || JSON.stringify(r.data));
r = await emu({ viewport: '800x600x-1' });
check('dpr=-1 rejected', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ viewport: '800x600x1000' });
check('dpr=1000 rejected (>10)', !!r.err && /dpr/i.test(r.err), r.err || JSON.stringify(r.data));
r = await emu({ viewport: '800x600x1..2' });
{
  // +'1..2' = NaN — NaN bypasses `dprN<=0 || dprN>10`. Does CDP reject NaN?
  const p = await ev(T1, `()=>({dpr:devicePixelRatio,iw:innerWidth})`);
  check('dpr=1..2 (NaN parse)', !!r.err, 'err=' + (r.err || 'NONE — NaN sent to CDP') + ' probe=' + JSON.stringify(p));
  await emu({ viewport: '' });
}
r = await emu({ viewport: '800x600x1,mobilefoo' });
check('viewport flag garbage rejected', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ viewport: '800x600x1,' });
check('trailing comma rejected', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ viewport: ' 800x600x1' });
check('leading space rejected', !!r.err, r.err || JSON.stringify(r.data));

// iPhone-ish preset (manual: tool has no device presets)
r = await emu({ viewport: '390x844x3,mobile,touch', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
{
  const p = await ev(T1, PROBE);
  check('iPhone-like: innerWidth=390 dpr=3 touch on UA=iPhone',
    !r.err && p.iw === 390 && p.dpr === 3 && p.touch === true && /iPhone/.test(p.ua),
    JSON.stringify(p));
}
// mobile flag on DESKTOP UA (isMobile weirdness)
r = await emu({ viewport: '500x400x1,mobile,touch', userAgent: '' });
{
  const p = await ev(T1, PROBE);
  check('mobile flag + desktop UA = split brain (layout mobile, UA desktop)',
    !r.err && p.iw === 500 && !/iPhone|Android/.test(p.ua) && p.mobMeta === false,
    'iw=' + p.iw + ' ua=' + p.ua.slice(0, 40) + ' uaDataMobile=' + p.mobMeta);
}
// TOUCH LEAK: re-set viewport without ,touch — code has no else-disable
r = await emu({ viewport: '800x600x1' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,touch:'ontouchstart' in window,mtp:navigator.maxTouchPoints})`);
  check('touch leaks across viewport re-set (no ,touch)', p.iw === 800 && p.touch === true,
    JSON.stringify(p) + '  <-- touch stays ON: cdp.js only disables on empty viewport');
}
r = await emu({ viewport: '' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,touch:'ontouchstart' in window,mtp:navigator.maxTouchPoints,dpr:devicePixelRatio})`);
  check('viewport "" clears metrics AND touch', !r.err && p.iw !== 800 && p.touch === false && p.mtp === 0,
    JSON.stringify(p) + ' baseline-iw=' + base.iw);
}
// landscape flag
r = await emu({ viewport: '900x400x1,mobile,touch,landscape' });
{
  const p = await ev(T1, `()=>({orient:screen.orientation.type,iw:innerWidth})`);
  check('landscape flag -> landscape-primary', !r.err && /landscape/.test(p.orient || ''), JSON.stringify(p));
  await emu({ viewport: '' });
}

// ================= B. CPU throttle =================
const b1 = await ev(T1, BENCH);
r = await emu({ cpuThrottlingRate: 4 });
const b4 = await ev(T1, BENCH);
check('cpu 4x actually slows JS', !r.err && b4 > b1 * 1.8, `baseline=${b1}ms throttled=${b4}ms ratio=${(b4 / b1).toFixed(1)}x`);
r = await emu({ cpuThrottlingRate: 20 });
const b20 = await ev(T1, BENCH);
check('cpu 20x applied', !r.err && b20 > b1 * 3, `rate20=${b20}ms vs base=${b1}ms`);
r = await emu({ cpuThrottlingRate: 0 });
check('cpu rate=0 rejected', !!r.err && />= 1/.test(r.err), r.err || JSON.stringify(r.data));
r = await emu({ cpuThrottlingRate: -4 });
check('cpu rate=-4 rejected', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ cpuThrottlingRate: 'abc' });
check("cpu rate='abc' rejected (NaN)", !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ cpuThrottlingRate: '4' });
check("cpu rate='4' string coerced (lenient)", !r.err, r.err || JSON.stringify(r.data));
r = await emu({ cpuThrottlingRate: 1e9 });
check('cpu rate=1e9 accepted by CDP (no upper bound)', !r.err, r.err || JSON.stringify(r.data));
await emu({ cpuThrottlingRate: 1 });
{
  const bx = await ev(T1, BENCH);
  check('cpu reset to 1 restores speed', bx < b4 * 0.7, `after reset=${bx}ms vs throttled=${b4}ms`);
}

// ================= C. network =================
r = await emu({ networkConditions: 'Slow 3G' });
{
  const f = await ev(T1, FETCH1);
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('Slow 3G adds ~400ms latency', !r.err && f.ms >= baseMs + 300, `fetch=${JSON.stringify(f)} baseline=${baseMs}ms onLine=${onl}`);
}
r = await emu({ networkConditions: 'Offline' });
{
  const f = await ev(T1, FETCH1);
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('Offline: fetch fails + navigator.onLine=false', !r.err && f.err && onl === false, `fetch=${JSON.stringify(f)} onLine=${onl}`);
}
r = await emu({ networkConditions: 'bogus' });
check('unknown preset rejected', !!r.err && /unknown network preset/.test(r.err), r.err || JSON.stringify(r.data));
r = await emu({ networkConditions: 'offline' });
check('preset case-sensitive (lowercase rejected)', !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ networkConditions: '' });
check('empty networkConditions has NO reset semantics', !!r.err, r.err || 'NONE' + '  <-- no way to clear network emulation via tool');
r = await emu({ networkConditions: 'None' });
check("'None' preset absent — cannot un-throttle via tool", !!r.err, r.err || JSON.stringify(r.data));
// still offline? verify previous Offline persisted through failed calls
{
  const onl = await ev(T1, `()=>navigator.onLine`);
  check('Offline persists through rejected calls', onl === false, 'onLine=' + onl);
}
// custom latency/throughput params don't exist — silent ignore?
r = await emu({ latency: -1, throughput: 0, networkConditions: 'Fast 3G' });
check('custom latency/throughput args silently ignored', !r.err && r.data && !('latency' in (r.data.applied || {})), 'applied=' + JSON.stringify(r.data && r.data.applied));
{
  const f = await ev(T1, FETCH1);
  check('recovery: Fast 3G works after Offline', !r.err && f.ms > 0, 'fetch=' + JSON.stringify(f));
}

// ================= D. locale/tz/geo/media =================
const tz0 = await ev(T1, `()=>Intl.DateTimeFormat().resolvedOptions().timeZone`);
r = await emu({ timezoneId: 'Mars/Olympus' });
check("timezoneId 'Mars/Olympus': unsupported param silently ignored", !r.err && r.data && Object.keys(r.data.applied || {}).length === 0, 'applied=' + JSON.stringify(r.data && r.data.applied));
r = await emu({ timezoneId: 'America/New_York' });
{
  const tz = await ev(T1, `()=>Intl.DateTimeFormat().resolvedOptions().timeZone`);
  check('timezoneId has no effect (not implemented)', tz === tz0, `tz=${tz} (still ${tz0}) applied=${JSON.stringify(r.data && r.data.applied)}`);
}
r = await emu({ locale: 'xx-INVALID' });
check("locale 'xx-INVALID': unsupported param silently ignored", !r.err && r.data && Object.keys(r.data.applied || {}).length === 0, 'applied=' + JSON.stringify(r.data && r.data.applied));
r = await emu({ prefersReducedMotion: 'reduce' });
{
  const rm = await ev(T1, `()=>matchMedia('(prefers-reduced-motion: reduce)').matches`);
  check('prefersReducedMotion: unsupported param silently ignored', !r.err && rm === false, 'applied=' + JSON.stringify(r.data && r.data.applied) + ' rm=' + rm);
}
r = await emu({ geolocation: '999,-999' });
check('geolocation lat=999/lon=-999 accepted (no range check)', !r.err, r.err || JSON.stringify(r.data));
r = await emu({ geolocation: 'abc,def' });
check("geolocation 'abc,def' rejected", !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ geolocation: '1' });
check("geolocation '1' (missing lon) rejected", !!r.err, r.err || JSON.stringify(r.data));
r = await emu({ geolocation: '1,2,3' });
check("geolocation '1,2,3' silently drops 3rd component", !r.err, r.err || JSON.stringify(r.data));
{
  const perm = await ev(T1, `async()=>{try{const p=await navigator.permissions.query({name:'geolocation'});return p.state}catch(e){return 'n/a:'+e.message}}`);
  console.log('   geolocation permission state:', JSON.stringify(perm), '(not triggering a prompt)');
}
r = await emu({ colorScheme: 'dark' });
{
  const d = await ev(T1, `()=>matchMedia('(prefers-color-scheme: dark)').matches`);
  check('colorScheme dark -> matchMedia dark=true', !r.err && d === true, 'dark=' + d);
}
r = await emu({ colorScheme: 'light' });
{
  const d = await ev(T1, `()=>({d:matchMedia('(prefers-color-scheme: dark)').matches,l:matchMedia('(prefers-color-scheme: light)').matches})`);
  check('colorScheme light -> light=true', !r.err && d.l === true && d.d === false, JSON.stringify(d));
}
r = await emu({ colorScheme: 'purple' });
check("colorScheme 'purple' (enum bypass — no schema validation)", !!r.err, 'err=' + (r.err || 'NONE — invalid enum reached CDP'));
r = await emu({ colorScheme: 'auto' });
{
  const d = await ev(T1, `()=>({d:matchMedia('(prefers-color-scheme: dark)').matches})`);
  check('colorScheme auto resets feature', !r.err && d.d === base.dark, JSON.stringify(d) + ' baseline dark=' + base.dark);
}
r = await emu({ userAgent: 'ADV15-UA\nInjected: yes' });
check('userAgent with newline (header injection attempt)', !r.err || /invalid|error/i.test(r.err || ''), 'err=' + (r.err || 'NONE — newline UA accepted'));
await emu({ userAgent: '' });
{
  const ua = await ev(T1, `()=>navigator.userAgent`);
  check('userAgent "" restores real UA', ua === base.ua || !/ADV15|Injected/.test(ua), 'ua=' + String(ua).slice(0, 60));
}

// ================= E. stacking + atomicity =================
// partial-apply trap: network succeeds, viewport throws -> network stays ON despite error
r = await emu({ networkConditions: 'Slow 3G', viewport: 'bogus' });
{
  const f = await ev(T1, FETCH1);
  check('non-atomic: error returned but networkConditions still applied', !!r.err && f.ms >= baseMs + 300,
    'err=' + (r.err || 'none') + ' fetch=' + JSON.stringify(f));
}
r = await emu({ networkConditions: 'Fast 3G', cpuThrottlingRate: 4, viewport: '500x400x2,mobile,touch', colorScheme: 'dark', userAgent: 'ADV15-STACK', geolocation: '40.7,-74', extraHttpHeaders: '{"X-Adv15":"yes"}' });
{
  const p = await ev(T1, PROBE);
  check('stacked emulation all applied', !r.err && p.iw === 500 && p.dpr === 2 && p.dark === true && p.ua === 'ADV15-STACK' && p.touch === true,
    JSON.stringify({ iw: p.iw, dpr: p.dpr, dark: p.dark, ua: p.ua, touch: p.touch }));
}
{
  await ev(T1, FETCH1);
  const net = await call('list_network_requests', { pageId: T1, pageSize: 3 });
  const reqs = (net.structuredContent && net.structuredContent.requests) || [];
  const last = reqs[reqs.length - 1] || {};
  const hdrs = JSON.stringify(last.requestHeaders || {});
  check('extraHttpHeaders actually sent (visible in recorded request)', /x-adv15/i.test(hdrs), 'last req headers: ' + hdrs.slice(0, 200));
}
// reset everything resettable in one call
r = await emu({ viewport: '', cpuThrottlingRate: 1, geolocation: '', userAgent: '', colorScheme: 'auto', extraHttpHeaders: '' });
{
  const p = await ev(T1, PROBE);
  const f = await ev(T1, FETCH1);
  check('reset call reverts viewport/UA/color (network CANNOT reset)',
    !r.err && p.iw === base.iw && p.ua === base.ua && p.dark === base.dark && p.touch === false && f.ms > baseMs + 100,
    JSON.stringify({ iw: p.iw, ua: p.ua.slice(0, 30), dark: p.dark, touch: p.touch, fetchMs: f.ms }));
}
// detach = the only real reset
r = await call('detach_debugger', { pageId: T1 });
{
  const f = await ev(T1, FETCH1);
  check('detach_debugger clears network emulation (only reset path)', f.ms < baseMs + 200, 'fetch after detach=' + JSON.stringify(f));
}

// ================= F. persistence =================
await emu({ viewport: '777x555x1', userAgent: 'NAVPERSIST-UA', cpuThrottlingRate: 2 });
await call('navigate_page', { pageId: T1, type: 'url', url: PAGE + '?nav=2' });
{
  const p = await ev(T1, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('emulation persists across navigation', p.iw === 777 && p.ua === 'NAVPERSIST-UA', JSON.stringify(p));
}
const np2 = await call('new_page', { url: PAGE, background: true });
const T2 = np2.structuredContent && np2.structuredContent.pageId;
myTabs.push(T2);
await new Promise(r => setTimeout(r, 800));
{
  const p = await ev(T2, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('no leak to other tabs', p.iw !== 777 && p.ua !== 'NAVPERSIST-UA', JSON.stringify({ iw: p.iw, ua: String(p.ua).slice(0, 40) }));
}
// tab close -> reopen clean
await call('close_page', { pageId: T1 });
const np3 = await call('new_page', { url: PAGE });
const T3 = np3.structuredContent && np3.structuredContent.pageId;
myTabs.push(T3);
await new Promise(r => setTimeout(r, 800));
{
  const p = await ev(T3, `()=>({iw:innerWidth,ua:navigator.userAgent})`);
  check('closing emulated tab leaves no residue on new tab', p.iw !== 777 && p.ua !== 'NAVPERSIST-UA', JSON.stringify({ iw: p.iw, ua: String(p.ua).slice(0, 40) }));
}

// ================= G. chrome:// / about:blank / bogus tab =================
const npc = await call('new_page', { url: 'chrome://version/', background: true });
const TC = npc.structuredContent && npc.structuredContent.pageId;
if (TC) {
  myTabs.push(TC);
  await new Promise(r => setTimeout(r, 500));
  const rc = await call('emulate', { pageId: TC, cpuThrottlingRate: 2 });
  check('emulate on chrome:// -> clean error', !!errOf(rc) && /chrome|attach|access/i.test(errOf(rc) || ''), errOf(rc) || JSON.stringify(rc.structuredContent));
} else check('emulate on chrome:// -> clean error', false, 'new_page chrome:// failed: ' + textOf(npc));

const npb = await call('new_page', { url: 'about:blank', background: true });
const TB = npb.structuredContent && npb.structuredContent.pageId;
myTabs.push(TB);
await new Promise(r => setTimeout(r, 500));
{
  const rb = await call('emulate', { pageId: TB, cpuThrottlingRate: 2, viewport: '333x333x1' });
  const eb = await ev(TB, `()=>innerWidth`);
  check('emulate on about:blank (debugger attaches; scripting unreachable per README)',
    !errOf(rb) && (eb && eb.__err), 'emulate=' + (errOf(rb) || JSON.stringify(rb.structuredContent)) + ' eval=' + JSON.stringify(eb).slice(0, 120));
}
{
  const rx = await call('emulate', { pageId: 99999999, cpuThrottlingRate: 2 });
  check('emulate on bogus pageId -> clean error', !!errOf(rx), errOf(rx) || 'NONE');
}

// ================= cleanup =================
for (const t of [TB, TC, T3, T2]) {
  if (!t) continue;
  await call('emulate', { pageId: t, viewport: '', cpuThrottlingRate: 1, userAgent: '', colorScheme: 'auto', geolocation: '', extraHttpHeaders: '' }).catch(() => {});
  await call('detach_debugger', { pageId: t }).catch(() => {});
  await call('close_page', { pageId: t }).catch(() => {});
}

const pass = results.filter(r => r.pass).length, fail = results.filter(r => !r.pass).length;
console.log('\n===== SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
for (const r of results.filter(r => !r.pass)) console.log('  FAIL: ' + r.name + ' -- ' + r.evidence);
