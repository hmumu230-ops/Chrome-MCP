// adversarial tester #04 — tab/page boundary fuzz
// Tracks every pageId it creates; closes ONLY those at the end.
// One MCP session; retries calls that die on the flaky extension socket.
import fs from 'node:fs';
import http from 'node:http';

const BASE = 'http://127.0.0.1:7890/mcp';
const OUT = new URL('./adv-04-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let sid = null, rpcId = 0;
const mine = new Set();          // pageIds I created
const results = [];              // {test, ok, detail}
const rec = (test, ok, detail) => { results.push({ test, ok, detail }); console.log(`${ok === 'PASS' ? '[PASS]' : ok === 'BUG' ? '[BUG!]' : ok === 'SEC' ? '[SEC!]' : ok === 'LIM' ? '[LIM]' : '[INFO]'} ${test} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  let body; try { body = JSON.parse(dataLine || t); } catch { body = { raw: t, status: res.status }; }
  return { status: res.status, body };
}

async function init() {
  sid = null;
  const r = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv04', version: '0' } });
  if (r.body.error) throw new Error('init failed: ' + JSON.stringify(r.body.error));
}

const FLAKY = /extension call timeout|extension disconnected|not connected|fetch failed/i;
async function call(tool, args = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await req('tools/call', { name: tool, arguments: args }); }
    catch (e) { if (i === tries - 1) return { isError: true, text: 'RPC ' + e.message }; await sleep(800); continue; }
    const res = r.body.result;
    if (res) {
      const text = (res.content || []).map(c => c.text || `[${c.type}]`).join('\n');
      const isErr = !!res.isError;
      if (isErr && FLAKY.test(text) && i < tries - 1) { await sleep(700); continue; }
      return { isError: isErr, text, structured: res.structuredContent };
    }
    if (r.body.error) return { isError: true, text: 'JSONRPC ' + JSON.stringify(r.body.error) };
    if (r.status !== 200) return { isError: true, text: `HTTP ${r.status}: ${r.body.raw || ''}` };
    if (i < tries - 1) { await sleep(700); continue; }
    return { isError: true, text: 'empty result ' + JSON.stringify(r.body).slice(0, 300) };
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newTab(url, extra = {}) {
  const r = await call('new_page', { url, background: true, ...extra });
  let id;
  try { id = (r.structured && r.structured.pageId) ?? JSON.parse((r.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
  if (id) mine.add(id);
  return { id, r };
}
async function closeTab(id) {
  if (!mine.has(id)) return;             // never touch foreign tabs
  mine.delete(id);
  await call('close_page', { pageId: id });
}
async function listPages() {
  const r = await call('list_pages');
  try { return JSON.parse(r.text); } catch { return r.structured?.items || []; }
}
const tabUrl = async (id) => (await listPages()).find(t => t.pageId === id)?.url;

// ---------- mini origin servers for iframe + nav targets ----------
function startServers() {
  const mk = (port, body) => new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      rsp.setHeader('content-type', 'text/html');
      rsp.end(body);
    }).listen(port, '0.0.0.0', () => res(s));
  });
  return Promise.all([
    mk(18141, `<html><title>ADV04-PARENT</title><body><h1>parent-page-18141</h1><button id="pb">parentBtn</button><iframe src="http://localhost:18142/child" style="width:400px;height:200px"></iframe></body></html>`),
    mk(18142, `<html><title>ADV04-CHILD</title><body><h2>child-frame-18142</h2><button id="cb" onclick="document.title='CHILDCLICKED';this.innerText='CLICKED-IN-CHILD'">childBtn</button></body></html>`),
    mk(18143, `<html><title>ADV04-TGT</title><body><h1>nav-target-18143</h1><button id="tb">targetBtn</button></body></html>`),
  ]);
}

// ============================================================
const servers = await startServers();
console.log('servers up on 18141/18142/18143');
await init();

try {
  // ---------- T1: evil URLs ----------
  const { id: t1 } = await newTab('about:blank');
  rec('T1.setup', 'INFO', `test tab=${t1}`);
  const evil = [
    ['javascript-inline', 'javascript:document.title="MCP_XSS"'],
    ['javascript-leadspace', '   javascript:document.title="MCP_XSS2"'],
    ['javascript-tab-in-scheme', 'java\tscript:document.title="MCP_XSS3"'],
    ['javascript-lf-in-scheme', 'java\nscript:document.title="MCP_XSS4"'],
    ['javascript-cr-in-scheme', 'java\rscript:document.title="MCP_XSS5"'],
    ['javascript-uppercase', 'JAVASCRIPT:document.title="MCP_XSS6"'],
    ['javascript-trailspace', 'javascript:document.title="MCP_XSS7"   '],
    ['data-html', 'data:text/html,<script>document.title="MCP_DATA"</script>'],
    ['data-leadspace', '  data:text/html,<h1>x</h1>'],
    ['file-winini', 'file:///C:/Windows/win.ini'],
    ['file-passwd', 'file:///etc/passwd'],
    ['chrome-settings', 'chrome://settings'],
    ['chrome-version', 'chrome://version'],
    ['chrome-extensions', 'chrome://extensions/'],
    ['chrome-netinternals', 'chrome://net-internals/'],
    ['about-blank', 'about:blank'],
    ['about-config-ish', 'about:version'],
    ['view-source-http', 'view-source:https://example.com/'],
    ['view-source-file', 'view-source:file:///C:/Windows/win.ini'],
    ['blob-fake', 'blob:https://example.com/00000000-0000-0000-0000-000000000000'],
    ['blob-null', 'blob:null/00000000-0000-0000-0000-000000000000'],
    ['malformed-empty', ''],
    ['malformed-noscheme', 'www.example.com'],
    ['malformed-protrel', '//example.com/'],
    ['malformed-space', 'ht tp://example.com/'],
    ['malformed-bracket', 'http://[::1'],
    ['newline-in-path', 'http://127.0.0.1:18143/\ninjected'],
    ['nullbyte', 'http://127.0.0.1:18143/\u0000abc'],
    ['ext-self', 'chrome-extension://pmhfdkkgjbfngeekdbdnjdnlnhmbinoh/popup.html'],
    ['ws-url', 'ws://127.0.0.1:7890/ws'],
    ['devtools', 'devtools://devtools/bundled/inspector.html'],
  ];
  for (const [name, url] of evil) {
    const r = await call('navigate_page', { pageId: t1, type: 'url', url });
    const finalUrl = await tabUrl(t1);
    const suspicious = /MCP_XSS|MCP_DATA/.test(r.text) || /MCP_XSS|MCP_DATA/.test(finalUrl || '');
    rec('T1.' + name, r.isError ? 'PASS' : (suspicious ? 'SEC' : (/javascript|data:|file:|chrome:\/\/(?!newtab)|view-source|blob:|devtools:|ws:/i.test(finalUrl || '') ? 'BUG' : 'PASS')),
      { err: r.isError ? r.text.slice(0, 220) : undefined, returned: r.isError ? undefined : r.text.slice(0, 220), finalUrl });
  }
  // 10MB URL — over MCP 4MB limit → transport-level reject expected
  const big = 'http://127.0.0.1:18143/?pad=' + 'A'.repeat(6 * 1024 * 1024);
  const bigR = await call('navigate_page', { pageId: t1, type: 'url', url: big });
  rec('T1.url-6MB', bigR.isError ? 'PASS' : 'BUG', bigR.text.slice(0, 200));
  // ~2MB URL — under MCP limit, stresses Chrome's own URL cap
  const big2 = 'http://127.0.0.1:18143/?pad=' + 'A'.repeat(2 * 1024 * 1024);
  const big2R = await call('navigate_page', { pageId: t1, type: 'url', url: big2 });
  rec('T1.url-2MB', big2R.isError ? 'PASS' : 'LIM', (big2R.text || '').slice(0, 200));

  // ---------- T2: pageId attacks ----------
  const badIds = [
    ['negative', -1], ['float', 1.5], ['string-abc', 'abc'], ['string-numeric', String(t1)],
    ['huge', 99999999999999999], ['zero', 0], ['bool', true], ['null', null],
    ['array', [t1]], ['object', { id: t1 }], ['windowId-as-pageId', 301370067],
  ];
  for (const [name, pid] of badIds) {
    const r = await call('navigate_page', { pageId: pid, type: 'url', url: 'http://127.0.0.1:18143/' });
    const clean = r.isError && !/extension call timeout|disconnected/.test(r.text);
    rec('T2.navigate.' + name, clean ? 'PASS' : 'BUG', r.text.slice(0, 200));
  }
  for (const [name, pid] of badIds.slice(0, 8)) {
    const r = await call('take_snapshot', { pageId: pid });
    const clean = r.isError && !/extension call timeout|disconnected/.test(r.text);
    rec('T2.snapshot.' + name, clean ? 'PASS' : 'BUG', r.text.slice(0, 160));
  }
  const rCloseBad = await call('close_page', { pageId: 1.5 });
  rec('T2.close.float', rCloseBad.isError ? 'PASS' : 'BUG', rCloseBad.text.slice(0, 160));
  const rCloseStr = await call('close_page', { pageId: 'abc' });
  rec('T2.close.string', rCloseStr.isError ? 'PASS' : 'BUG', rCloseStr.text.slice(0, 160));
  // closed tab id — create, close, then reuse
  const { id: dead } = await newTab('http://127.0.0.1:18143/');
  await closeTab(dead);
  await sleep(400);
  for (const tool of ['navigate_page', 'take_snapshot', 'select_page', 'close_page']) {
    const r = await call(tool, { pageId: dead, type: 'url', url: 'http://127.0.0.1:18143/' });
    rec('T2.closedtab.' + tool, r.isError ? 'PASS' : 'BUG', r.text.slice(0, 160));
  }

  // ---------- T3: rapid lifecycle ----------
  const origins = [
    'http://127.0.0.1:18143/', 'https://example.com/', 'https://www.iana.org/help/example-domains',
    'http://localhost:18141/', 'https://en.wikipedia.org/wiki/Main_Page', 'about:blank',
    'http://127.0.0.1:18142/child', 'https://github.com/',
  ];
  const created = await Promise.all(origins.map(u => newTab('about:blank')));
  const ids = created.map(c => c.id).filter(Boolean);
  rec('T3.created', 'INFO', `created ${ids.length}: ${ids.join(',')}`);
  const navs = await Promise.all(ids.map((id, i) => call('navigate_page', { pageId: id, type: 'url', url: origins[i] })));
  navs.forEach((r, i) => rec('T3.nav.' + i, r.isError ? 'BUG' : 'PASS', r.text.slice(0, 140)));
  // close odd-indexed
  const survivors = [], closers = [];
  ids.forEach((id, i) => (i % 2 ? closers.push(id) : survivors.push(id)));
  await Promise.all(closers.map(id => closeTab(id)));
  await sleep(600);
  const listed = await listPages();
  for (const id of closers) {
    const gone = !listed.some(t => t.pageId === id);
    rec('T3.closed.' + id, gone ? 'PASS' : 'BUG', gone ? 'gone' : 'still listed');
  }
  // snapshot survivors — verify url in each snapshot belongs to that tab (no cross-talk)
  const snaps = await Promise.all(survivors.map(id => call('take_snapshot', { pageId: id })));
  const expect = { [survivors[0]]: '18143', [survivors[1]]: 'iana.org', [survivors[2]]: 'wikipedia.org', [survivors[3]]: '18142' };
  for (let i = 0; i < survivors.length; i++) {
    const id = survivors[i];
    const s = snaps[i];
    const urlField = (s.structured && s.structured.url) || '';
    const want = expect[id] || '';
    const own = urlField.includes(want);
    const foreign = Object.values(expect).some(o => o && urlField.includes(o) && o !== want);
    rec('T3.snapshot.' + id, s.isError ? 'BUG' : (own && !foreign ? 'PASS' : 'BUG'), { urlField: urlField.slice(0, 90), want });
  }
  for (const id of survivors) await closeTab(id);

  // ---------- T4: select_page on background tab ----------
  const { id: sel } = await newTab('http://127.0.0.1:18143/');
  const { id: front } = await newTab('http://127.0.0.1:18141/');
  const rSel = await call('select_page', { pageId: sel, bringToFront: true });
  await sleep(400);
  const after = await listPages();
  const selTab = after.find(t => t.pageId === sel);
  rec('T4.select-background', !rSel.isError && selTab && selTab.active ? 'PASS' : 'BUG', { r: rSel.text.slice(0, 140), active: selTab && selTab.active });
  // select with a bogus pageId while another window focused
  const rSelBad = await call('select_page', { pageId: 424242424, bringToFront: true });
  rec('T4.select-nonexistent', rSelBad.isError ? 'PASS' : 'BUG', rSelBad.text.slice(0, 140));
  await closeTab(sel); await closeTab(front);

  // ---------- T5: navigate + immediate snapshot/click race ----------
  const { id: race } = await newTab('http://127.0.0.1:18143/');
  await sleep(800);
  const s1 = await call('take_snapshot', { pageId: race });
  const uidMatch = s1.text.match(/\[([A-Za-z0-9]+)\] button/);
  const staleUid = uidMatch && uidMatch[1];
  rec('T5.snapshot1', 'INFO', { uid: staleUid, head: s1.text.slice(0, 200) });
  // fire navigate and (in parallel) snapshot + click with old uid
  const pNav = call('navigate_page', { pageId: race, type: 'url', url: 'http://localhost:18142/child' });
  await sleep(30); // let nav start
  const pSnap = call('take_snapshot', { pageId: race });
  const pClick = staleUid ? call('click', { pageId: race, uid: staleUid }) : Promise.resolve({ isError: true, text: 'no uid' });
  const [rNav, rSnap, rClick] = await Promise.all([pNav, pSnap, pClick]);
  rec('T5.race.nav', rNav.isError ? 'BUG' : 'PASS', rNav.text.slice(0, 160));
  rec('T5.race.snapshot', 'INFO', rSnap.text.slice(0, 300));
  // a stale uid must NOT report a successful click on the new doc
  const clickedOk = !rClick.isError && /clicked/.test(rClick.text);
  rec('T5.race.stale-click', clickedOk ? 'BUG' : 'PASS', rClick.text.slice(0, 220));
  // post-nav: old uid again
  if (staleUid) {
    const rClick2 = await call('click', { pageId: race, uid: staleUid });
    rec('T5.postnav.stale-click', rClick2.isError ? 'PASS' : 'BUG', rClick2.text.slice(0, 220));
  }
  await closeTab(race);

  // ---------- T6: new_page twice quickly — id uniqueness ----------
  const [n1, n2, n3] = await Promise.all([newTab('about:blank'), newTab('about:blank'), newTab('about:blank')]);
  const uniq = new Set([n1.id, n2.id, n3.id].filter(Boolean));
  rec('T6.uniqueness', uniq.size === 3 ? 'PASS' : 'BUG', { ids: [n1.id, n2.id, n3.id] });
  const lp = await listPages();
  const allListed = [n1.id, n2.id, n3.id].every(id => lp.some(t => t.pageId === id));
  rec('T6.list-consistency', allListed ? 'PASS' : 'BUG', { allListed });
  await Promise.all([n1.id, n2.id, n3.id].map(id => closeTab(id)));

  // ---------- T7: cross-origin iframe ----------
  const { id: ifr } = await newTab('http://127.0.0.1:18141/');
  await sleep(1200);
  const sIfr = await call('take_snapshot', { pageId: ifr });
  const hasFrame = /iframe frameId=/.test(sIfr.text);
  const childUidM = sIfr.text.match(/\[([^\]]+)\] button "childBtn"/);
  const parentUidM = sIfr.text.match(/\[([^\]]+)\] button "parentBtn"/);
  rec('T7.snapshot-includes-iframe', hasFrame ? 'PASS' : 'BUG', sIfr.text.slice(0, 500));
  if (childUidM) {
    const rC = await call('click', { pageId: ifr, uid: childUidM[1] });
    rec('T7.click-child-frame', !rC.isError ? 'PASS' : 'BUG', rC.text.slice(0, 200));
    await sleep(500);
    const sAfter = await call('take_snapshot', { pageId: ifr });
    rec('T7.click-effect-in-child', /CLICKED-IN-CHILD/.test(sAfter.text) ? 'PASS' : 'BUG', sAfter.text.slice(0, 400));
  } else rec('T7.click-child-frame', 'BUG', 'no child uid in snapshot');
  if (parentUidM) {
    const rP = await call('click', { pageId: ifr, uid: parentUidM[1] });
    rec('T7.click-parent-still-works', !rP.isError ? 'PASS' : 'BUG', rP.text.slice(0, 160));
  }
  await closeTab(ifr);

  // ---------- T1 cleanup ----------
  await closeTab(t1);
} catch (e) {
  rec('FATAL', 'BUG', String(e && e.stack || e).slice(0, 500));
} finally {
  // close anything still mine
  for (const id of [...mine]) await closeTab(id);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  const bugs = results.filter(r => r.ok === 'BUG' || r.ok === 'SEC');
  console.log(`\n==== DONE: ${results.length} checks, ${bugs.length} BUG/SEC ====`);
  for (const s of servers) s.close();
  process.exit(0);
}
