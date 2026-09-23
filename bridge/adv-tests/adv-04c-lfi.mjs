// adv-04c: file:// readback (LFI), new_page landing verification, incognito window test
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, rpcId = 0;
const mine = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: { raw: t } }; }
}
async function init() {
  sid = null;
  const r = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv04c', version: '0' } });
  if (!sid) throw new Error('no sid; status=' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
}
const FLAKY = /extension call timeout|extension disconnected|not connected|fetch failed/i;
async function call(tool, args = {}, tries = 8) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await req('tools/call', { name: tool, arguments: args }); }
    catch (e) { await sleep(900); continue; }
    const res = r.body.result;
    if (res) {
      const text = (res.content || []).map(c => c.text || `[${c.type}]`).join('\n');
      if (res.isError && FLAKY.test(text) && i < tries - 1) { await sleep(700); continue; }
      return { isError: !!res.isError, text };
    }
    if ((r.status === 503 || r.status === 404) && i < tries - 1) { await init().catch(() => {}); await sleep(500); continue; }
    return { isError: true, text: `HTTP ${r.status}: ${(r.body.raw || JSON.stringify(r.body)).slice(0, 160)}` };
  }
  return { isError: true, text: 'retries exhausted' };
}
async function listPages() { const r = await call('list_pages'); try { return JSON.parse(r.text); } catch { return []; } }
async function closeTab(id) { if (!mine.has(id)) return; mine.delete(id); await call('close_page', { pageId: id }); }
const L = (...a) => console.log(...a);

await init();
const sentinel = 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv04-sentinel.txt';
fs.writeFileSync(sentinel, 'MCP-LFI-SENTINEL-9042 topsecret=flag{lfi}\nline2 secret2');

try {
  // ---- 1. file:// tab then read back ----
  let r = await call('new_page', { url: 'file:///' + sentinel.replace(/\\/g, '/'), background: true });
  let fid; try { fid = JSON.parse((r.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
  if (fid) mine.add(fid);
  L('file-tab create:', r.text.slice(0, 200), 'id=', fid);
  await sleep(1200);
  let lp = await listPages();
  L('landed url:', JSON.stringify((lp.find(t => t.pageId === fid) || {}).url));
  if (fid) {
    for (const [tool, args] of [
      ['extract_text', {}],
      ['take_snapshot', {}],
      ['evaluate_script', { function: '() => document.body.innerText' }],
      ['take_screenshot', {}],
    ]) {
      const rr = await call(tool, { pageId: fid, ...args });
      const leaked = /MCP-LFI-SENTINEL/.test(rr.text);
      L(`${tool} on file:// => ${leaked ? '*** CONTENT LEAKED ***' : 'no leak'} :: ${rr.text.slice(0, 260)}`);
    }
    // also try win.ini directly
    const rr = await call('navigate_page', { pageId: fid, type: 'url', url: 'file:///C:/Windows/win.ini' });
    L('nav win.ini:', rr.text.slice(0, 160));
    await sleep(800);
    const e2 = await call('extract_text', { pageId: fid });
    L('extract win.ini =>', /extensions|fonts|\.fon|intl/i.test(e2.text) ? '*** LEAKED ***' : 'no', '::', e2.text.slice(0, 260));
    await closeTab(fid);
  }

  // ---- 2. verify data:/view-source/file new_page actually landed ----
  for (const [name, url] of [
    ['data', 'data:text/html,<title>NP_DATA_OK</title><h1>NP_DATA_OK</h1>'],
    ['viewsrc-file', 'view-source:file:///C:/Windows/win.ini'],
    ['file', 'file:///C:/Windows/win.ini'],
    ['chrome', 'chrome://version'],
  ]) {
    const rr = await call('new_page', { url, background: true });
    let id; try { id = JSON.parse((rr.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
    if (id) mine.add(id);
    await sleep(1500);
    const lp2 = await listPages();
    const t = lp2.find(x => x.pageId === id);
    L(`new_page ${name}: ret=${rr.text.slice(0, 120).replace(/\n/g, ' ')} landed=${t ? t.url : 'TAB-GONE'}`);
    if (id) await closeTab(id);
  }

  // ---- 3. incognito isolatedContext ----
  const ri = await call('new_page', { url: 'http://example.com/', isolatedContext: 'x', background: true });
  L('isolatedContext:', ri.text.slice(0, 220));
  let iid; try { iid = JSON.parse((ri.text.match(/\{.*\}/s) || ['{}'])[0]).pageId; } catch {}
  if (iid) { mine.add(iid); await sleep(600); await closeTab(iid); }

  // ---- 4. another-window select (if incognito worked, its tab lived in window 2) ----
  // done implicitly; also test bringToFront on a tab while Chrome minimized is not feasible via API — skip.

  // ---- 5. pageId=windowId variants on other tools ----
  for (const tool of ['resize_page', 'evaluate_script', 'take_screenshot']) {
    const rr = await call(tool, { pageId: 301370067, width: 800, height: 600, function: '() => 1' });
    L(`${tool} windowId-as-pageId =>`, rr.text.slice(0, 140));
  }
} finally {
  for (const id of [...mine]) await closeTab(id);
  try { fs.unlinkSync(sentinel); } catch {}
  L('DONE');
  process.exit(0);
}
