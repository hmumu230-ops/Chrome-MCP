// adv-04 follow-up: file:// LFI escalation, iframe click, cross-tab uid,
// new_page url-validation bypass, misc pageId edge cases.
import fs from 'node:fs';
import http from 'node:http';

const BASE = 'http://127.0.0.1:7890/mcp';
const OUT = new URL('./adv-04b-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let sid = null, rpcId = 0;
const mine = new Set();
const results = [];
const rec = (test, ok, detail) => { results.push({ test, ok, detail }); console.log(`[${ok}] ${test} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

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
  const r = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv04b', version: '0' } });
  if (r.body.error) throw new Error('init failed: ' + JSON.stringify(r.body.error));
  if (!sid) throw new Error('no session id from init — pool full? status=' + r.status);
}
const FLAKY = /extension call timeout|extension disconnected|not connected|fetch failed/i;
async function call(tool, args = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await req('tools/call', { name: tool, arguments: args }); }
    catch (e) { if (i === tries - 1) return { isError: true, text: 'RPC ' + e.message }; await sleep(800); continue; }
    const res = r.body.result;
    if (res) {
      const text = (res.content || []).map(c => c.text || `[${c.type}]`).join('\n');
      if (res.isError && FLAKY.test(text) && i < tries - 1) { await sleep(700); continue; }
      return { isError: !!res.isError, text, structured: res.structuredContent };
    }
    if (r.status === 503 || r.status === 404) { // pool pressure / lost session — re-init once
      if (i < tries - 1) { await init().catch(() => {}); await sleep(500); continue; }
    }
    if (r.body.error) return { isError: true, text: 'JSONRPC ' + JSON.stringify(r.body.error) };
    return { isError: true, text: `HTTP ${r.status}: ${r.body.raw || JSON.stringify(r.body).slice(0, 200)}` };
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function newTab(url, extra = {}) {
  const r = await call('new_page', { url, background: true, ...extra });
  let id; try { id = (r.structured && r.structured.pageId) ?? JSON.parse((r.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
  if (id) mine.add(id);
  return { id, r };
}
async function closeTab(id) { if (!mine.has(id)) return; mine.delete(id); await call('close_page', { pageId: id }); }
async function listPages() { const r = await call('list_pages'); try { return JSON.parse(r.text); } catch { return r.structured?.items || []; } }

const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<html><title>ADV04B-P</title><body><h1>parent-B</h1><iframe src="http://localhost:18152/c" style="width:400px;height:200px"></iframe></body></html>`); }).listen(18151, '0.0.0.0');
const srv2 = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<html><title>ADV04B-C</title><body><h2>child-B</h2><button id="cb" onclick="this.innerText='CHILD-CLICKED'">childBtnB</button><input id="ci"></body></html>`); }).listen(18152, '0.0.0.0');
const srv3 = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<html><title>ADV04B-T</title><body><button id="tb">targetBtnB</button></body></html>`); }).listen(18153, '0.0.0.0');
await new Promise(r => setTimeout(r, 400));

await init();
try {
  // ---- F1: file:// LFI escalation ----
  const { id: f1 } = await newTab('about:blank');
  // write a sentinel file the browser can definitely read
  const sentinel = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv04-sentinel.txt';
  fs.writeFileSync(sentinel, 'MCP-LFI-SENTINEL-9042 topsecret=flag{lfi}');
  const nav = await call('navigate_page', { pageId: f1, type: 'url', url: 'file:///' + sentinel.replace(/\\/g, '/') });
  rec('F1.navigate-file', 'INFO', nav.text.slice(0, 200));
  await sleep(500);
  const ex = await call('extract_text', { pageId: f1 });
  rec('F1.extract_text-on-file', /MCP-LFI-SENTINEL/.test(ex.text) ? 'SEC' : 'INFO', ex.text.slice(0, 300));
  const sn = await call('take_snapshot', { pageId: f1 });
  rec('F1.snapshot-on-file', /MCP-LFI-SENTINEL/.test(sn.text) ? 'SEC' : 'INFO', sn.text.slice(0, 300));
  const ev = await call('evaluate_script', { pageId: f1, function: '() => document.body.innerText' });
  rec('F1.eval-on-file', /MCP-LFI-SENTINEL/.test(ev.text) ? 'SEC' : 'INFO', ev.text.slice(0, 300));
  await closeTab(f1);
  try { fs.unlinkSync(sentinel); } catch {}

  // ---- F2: new_page URL validation bypass ----
  for (const [name, url] of [
    ['newpage-file', 'file:///C:/Windows/win.ini'],
    ['newpage-data', 'data:text/html,<h1>owned</h1>'],
    ['newpage-js', 'javascript:document.title="NPXSS"'],
    ['newpage-js-leadspace', '  javascript:document.title="NPXSS2"'],
    ['newpage-chrome', 'chrome://version'],
    ['newpage-viewsource-file', 'view-source:file:///C:/Windows/win.ini'],
  ]) {
    const r = await call('new_page', { url, background: true });
    let id; try { id = (r.structured && r.structured.pageId) ?? JSON.parse((r.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
    if (id) mine.add(id);
    await sleep(600);
    const lp = await listPages();
    const t = lp.find(x => x.pageId === id);
    rec('F2.' + name, r.isError ? 'PASS' : 'BUG', { ret: r.text.slice(0, 160), landed: t && t.url });
    if (id) await closeTab(id);
  }

  // ---- F3: iframe interaction (redo with correct parsing) ----
  const { id: ifr } = await newTab('http://127.0.0.1:18151/');
  await sleep(1200);
  const sIfr = await call('take_snapshot', { pageId: ifr });
  const text = sIfr.text.replace(/\\"/g, '"'); // content is JSON-escaped
  const childUidM = text.match(/\[([^\]]+)\] button "childBtnB"/);
  const parentUidM = text.match(/\[([^\]]+)\] button "parentB"/);
  const inputUidM = text.match(/\[([^\]]+)\] textbox/);
  rec('F3.snapshot', childUidM ? 'PASS' : 'BUG', { child: childUidM && childUidM[1], parent: parentUidM && parentUidM[1], input: inputUidM && inputUidM[1], raw: text.slice(0, 400) });
  if (childUidM) {
    const rc = await call('click', { pageId: ifr, uid: childUidM[1] });
    rec('F3.click-in-iframe', rc.isError ? 'BUG' : 'PASS', rc.text.slice(0, 200));
    await sleep(400);
    const s2 = await call('take_snapshot', { pageId: ifr });
    rec('F3.verify-child-clicked', /CHILD-CLICKED/.test(s2.text.replace(/\\"/g, '"')) ? 'PASS' : 'BUG', s2.text.slice(0, 300));
  }
  if (inputUidM) {
    const rf = await call('fill', { pageId: ifr, uid: inputUidM[1], value: 'iframe-fill-ok' });
    rec('F3.fill-in-iframe', rf.isError ? 'BUG' : 'PASS', rf.text.slice(0, 160));
  }

  // ---- F4: cross-tab uid use ----
  const { id: tA } = await newTab('http://127.0.0.1:18153/');
  await sleep(800);
  const sA = await call('take_snapshot', { pageId: tA });
  const uidA = (sA.text.replace(/\\"/g, '"').match(/\[([^\]]+)\] button/) || [])[1];
  rec('F4.uidA', 'INFO', uidA);
  // use tab A's uid on the iframe tab (tB=ifr)
  const rX = await call('click', { pageId: ifr, uid: uidA });
  rec('F4.click-uidA-on-tabB', rX.isError ? 'PASS' : 'SEC', rX.text.slice(0, 200));
  // and on a fresh tab that was never snapshotted
  const { id: tC } = await newTab('about:blank');
  const rX2 = await call('click', { pageId: tC, uid: uidA });
  rec('F4.click-uidA-on-unsnapshotted', rX2.isError ? 'PASS' : 'SEC', rX2.text.slice(0, 200));
  // fabricated uid with right shape
  const rX3 = await call('click', { pageId: ifr, uid: 'zzz9e99' });
  rec('F4.forged-uid', rX3.isError ? 'PASS' : 'INFO', rX3.text.slice(0, 200));
  // uid with selector-injection chars
  const rX4 = await call('click', { pageId: ifr, uid: 'x"],input,[data-x="' });
  rec('F4.uid-selector-injection', rX4.isError ? 'PASS' : 'SEC', rX4.text.slice(0, 200));

  // ---- F5: misc pageId/nav edge cases ----
  const r1 = await call('navigate_page', { pageId: tA });                       // no type, no url
  rec('F5.nav-no-args', r1.isError ? 'PASS' : 'BUG', r1.text.slice(0, 160));
  const r2 = await call('navigate_page', { pageId: tA, type: 'reload' });       // reload — no url needed
  rec('F5.nav-reload', 'INFO', r2.text.slice(0, 160));
  const r3 = await call('navigate_page', { pageId: tA, type: 'bogus', url: 'http://127.0.0.1:18153/' });
  rec('F5.nav-bogus-type', r3.isError ? 'PASS' : 'BUG', r3.text.slice(0, 160));
  const r4 = await call('navigate_page', { pageId: tA, type: 'url', url: 'http://127.0.0.1:18153/', extra: 'junk' });
  rec('F5.nav-extra-prop', 'INFO', r4.text.slice(0, 160));
  // list_pages consistency after all this
  const lpEnd = await listPages();
  rec('F5.final-list', 'INFO', `open tabs total=${lpEnd.length}`);

  for (const id of [ifr, tA, tC]) await closeTab(id);
} catch (e) {
  rec('FATAL', 'BUG', String(e && e.stack || e).slice(0, 500));
} finally {
  for (const id of [...mine]) await closeTab(id);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.log(`\n==== DONE: ${results.length} checks ====`);
  srv.close(); srv2.close(); srv3.close();
  process.exit(0);
}
