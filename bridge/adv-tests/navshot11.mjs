// Screenshot while the tab is navigating/loading.
const BASE = 'http://127.0.0.1:7890/mcp';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const OUT = path.join(os.tmpdir(), 'adv11'); fs.mkdirSync(OUT, { recursive: true });
let sid = null, reqId = 0;
async function rawReq(method, params, id, timeoutMs = 60000) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: t }; }
}
async function waitConnected(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const s = await (await fetch('http://127.0.0.1:7890/', { signal: AbortSignal.timeout(4000) })).json(); if (s.extensionConnected) return true; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}
async function init() {
  for (let i = 0; i < 40; i++) {
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11nav', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
async function callOnce(tool, args, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, timeoutMs);
    const c = r.body && r.body.result && r.body.result.content;
    return { ms: Date.now() - t0, content: c, isError: r.body.result && r.body.result.isError };
  } catch (e) { return { ms: Date.now() - t0, error: String(e && e.message || e) }; }
}
const pageId = Number(process.argv[2]);
await waitConnected(); await init();
// navigate to a heavier page; fire screenshot ~150ms in (mid-load), then right after nav returns
const navP = callOnce('navigate_page', { pageId, type: 'url', url: 'https://en.wikipedia.org/wiki/Main_Page' }, 90000);
await new Promise(r => setTimeout(r, 150));
const shotDuring = await callOnce('take_screenshot', { pageId }, 45000);
const navRes = await navP;
const shotAfter = await callOnce('take_screenshot', { pageId }, 45000);
const sum = (r) => {
  const img = r.content && r.content.find(x => x.type === 'image');
  if (img) { const b = Buffer.from(img.data, 'base64'); return { ms: r.ms, png: { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }, bytes: b.length }; }
  return { ms: r.ms, err: ((r.content && r.content.map(x => x.text).join(' ')) || r.error || '').slice(0, 250), isError: r.isError };
};
console.log(JSON.stringify({ navMs: navRes.ms, navOk: !navRes.isError, during: sum(shotDuring), after: sum(shotAfter) }));
setTimeout(() => process.exit(0), 300);
