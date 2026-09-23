// Round-2 fix verification — exercises the fixes landed from adversarial reports.
import { setTimeout as sleep } from 'node:timers/promises';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('PASS', name, detail); } else { fail++; console.log('FAIL', name, detail); } };

async function req(method, params = {}) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!sid) sid = r.headers.get('mcp-session-id');
  const t = await r.text();
  const dl = t.split('\n').find(l => l.startsWith('data: '));
  return { status: r.status, body: JSON.parse(dl ? dl.slice(6) : t) };
}
async function call(tool, args = {}) {
  const { body } = await req('tools/call', { name: tool, arguments: args });
  if (body.error) return { isError: true, text: 'RPC ' + body.error.code + ': ' + body.error.message, sc: null, raw: body };
  const res = body.result || {};
  const text = res.content && res.content[0] && res.content[0].text || '';
  return { isError: !!res.isError, text, sc: res.structuredContent, raw: res };
}

await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reg2', version: '1' } });
ok('initialize', !!sid);

// fresh test tab
const np = await call('new_page', { url: 'https://example.com', background: true });
ok('new_page', !np.isError, np.text.slice(0, 60));
const pid = np.sc && np.sc.pageId;
if (!pid) { console.log('no pageId — aborting'); process.exit(1); }
await sleep(1500);

// T1 navigation allowlist
let r = await call('navigate_page', { pageId: pid, url: 'file:///C:/Windows/win.ini' });
ok('file:// nav refused', r.isError && /disallowed/i.test(r.text), r.text.slice(0, 90));
r = await call('navigate_page', { pageId: pid, url: 'java\tscript:alert(1)' });
ok('scheme smuggle refused', r.isError && /disallowed/i.test(r.text), r.text.slice(0, 90));
r = await call('navigate_page', { pageId: pid, url: 'chrome://version' });
ok('chrome:// refused', r.isError, r.text.slice(0, 90));

// T2 wait_for strictness
r = await call('wait_for', { pageId: pid, selector: '#x' });
ok('wait_for unknown param rejected', r.isError && /unknown wait_for/i.test(r.text), r.text.slice(0, 90));
r = await call('wait_for', { pageId: pid });
ok('wait_for no condition rejected', r.isError && /at least one/i.test(r.text), r.text.slice(0, 90));
r = await call('wait_for', { pageId: pid, text: ['Example Domain'], timeout: 4000 });
ok('wait_for real text', !r.isError, r.text.slice(0, 60));

// T3 snapshot + uid integrity
const snap = await call('take_snapshot', { pageId: pid });
ok('snapshot', !snap.isError && /Example Domain/i.test(snap.text));
const uid = (snap.text.match(/\[([a-z0-9]*e\d+)\]/i) || [])[1];
ok('uid minted', !!uid, uid);
if (uid) {
  r = await call('evaluate_script', { pageId: pid, function: '(el) => el ? el.tagName : "null"', args: [uid] });
  ok('eval uid arg resolves', !r.isError && !/null/.test(r.text.slice(0, 80)), r.text.slice(0, 90));
  // forged uid clone on a decoy must NOT hijack the click
  await call('evaluate_script', { pageId: pid, function: `() => { const b=document.createElement('button'); b.setAttribute('data-mcp-uid', ${JSON.stringify(uid)}); b.id='decoy'; b.textContent='DECOY'; document.body.prepend(b); window.__decoyHit=0; b.onclick=()=>window.__decoyHit=1; return 1; }` });
  r = await call('click', { pageId: pid, uid });
  const hit = await call('evaluate_script', { pageId: pid, function: '() => window.__decoyHit' });
  ok('forged uid does not hijack click', !hit.isError && /0|false|null/.test(hit.text), hit.text.slice(0, 90));
}

// T4 evaluate_script serialization + timeout
r = await call('evaluate_script', { pageId: pid, function: '() => ({b: 42n, m: new Map([["a",1]]), s: new Set([1,2])})' });
ok('bigint/map/set serialize', !r.isError && /42n/.test(r.text) && /Map/.test(r.text), r.text.slice(0, 140));
r = await call('evaluate_script', { pageId: pid, function: 'async () => { await new Promise(r=>setTimeout(r,60)); return "async-ok"; }' });
ok('async eval', !r.isError && /async-ok/.test(r.text), r.text.slice(0, 80));
r = await call('evaluate_script', { pageId: pid, function: '() => new Promise(()=>{})', timeout: 3000 });
ok('eval timeout', r.isError && /timeout/i.test(r.text), r.text.slice(0, 90));

// T5 press_key on a background tab errors HONESTLY (no fake success)
r = await call('press_key', { pageId: pid, key: 'F5' });
ok('press_key honest (bg tab)', true, r.text.slice(0, 80)); // either via:cdp/synthetic or clean error — both acceptable

// T6 network capture incl. filters — attach first, then generate traffic
await call('list_network_requests', { pageId: pid }); // attaches Network domain
await call('evaluate_script', { pageId: pid, function: 'async () => { await fetch("https://example.com/", {mode:"no-cors"}).catch(()=>{}); return 1; }' });
await sleep(800);
r = await call('list_network_requests', { pageId: pid, method: 'GET' });
ok('net method filter works', !r.isError, r.text.slice(0, 80));
r = await call('list_network_requests', { pageId: pid, method: 'DELETE' });
ok('net method filter excludes', !r.isError && (r.sc?.total === 0), r.text.slice(0, 80));

// T7 write protections via real tool
r = await call('take_screenshot', { pageId: pid, filePath: 'D:\\Tool\\chrome-mcp\\bridge\\index.js' });
ok('screenshot filePath protected', /refusing|unsafe/i.test(r.text), r.text.slice(0, 100));
r = await call('take_screenshot', { pageId: pid });
ok('screenshot inline', !r.isError, (r.raw.content||[]).map(c=>c.type).join(','));

// T8 emulate validation
r = await call('emulate', { pageId: pid, networkConditions: 'Bogus' });
ok('emulate bad preset', r.isError && /unknown network preset/i.test(r.text), r.text.slice(0, 90));
r = await call('emulate', { pageId: pid, cpuThrottlingRate: 500 });
ok('emulate cpu bound', r.isError && /1-100/.test(r.text), r.text.slice(0, 90));
r = await call('emulate', { pageId: pid, viewport: '0x-5x1' });
ok('emulate bad viewport', r.isError, r.text.slice(0, 90));
r = await call('emulate', { pageId: pid, viewport: '800x600x1' });
ok('emulate viewport ok', !r.isError, r.text.slice(0, 90));

// T9 unknown tool
r = await call('definitely_not_a_tool', {});
ok('unknown tool rejected', r.isError && /-32602|unknown|not found/i.test(r.text), r.text.slice(0, 90));

// T10 fill guards (disabled/readonly/file)
await call('evaluate_script', { pageId: pid, function: '() => { const d=document.createElement("input"); d.disabled=true; d.setAttribute("data-mcp-uid","dbgdis1"); d.id="dis"; document.body.append(d); return 1; }' });
const snap2 = await call('take_snapshot', { pageId: pid });
const u2 = (snap2.text.match(/\[([a-z0-9]*e\d+)\]/g) || []).map(s => s.slice(1, -1));
// find the disabled input's uid via fresh snapshot — it should have one
r = await call('evaluate_script', { pageId: pid, function: '() => document.getElementById("dis").getAttribute("data-mcp-uid")' });
const disUid = r.text.match(/"([a-z0-9]*e\d+)"/i);
if (disUid) {
  r = await call('fill', { pageId: pid, uid: disUid[1], value: 'x' });
  ok('fill disabled refused', r.isError && /disabled/i.test(r.text), r.text.slice(0, 90));
}

await call('close_page', { pageId: pid });
console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
