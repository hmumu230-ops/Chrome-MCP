// Create 2 bg tabs, then fire 5 parallel take_screenshot on 5 different tabs.
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11par', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
// one-shot call, NO retry — measures true parallel behavior
async function callOnce(tool, args, timeoutMs = 45000) {
  const t0 = Date.now();
  try {
    const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, timeoutMs);
    const c = r.body && r.body.result && r.body.result.content;
    return { ms: Date.now() - t0, content: c, isError: r.body.result && r.body.result.isError, status: r.status };
  } catch (e) { return { ms: Date.now() - t0, error: String(e && e.message || e) }; }
}
await waitConnected(); await init();
// create 2 more bg tabs
const n1 = await callOnce('new_page', { url: 'https://example.com/', background: true });
const n2 = await callOnce('new_page', { url: 'https://www.iana.org/help/example-domains', background: true });
const id1 = Number((n1.content && n1.content[0].text.match(/"pageId":\s*(\d+)/) || [])[1]);
const id2 = Number((n2.content && n2.content[0].text.match(/"pageId":\s*(\d+)/) || [])[1]);
console.log('NEWTABS', id1, id2);
await new Promise(r => setTimeout(r, 800));
const ids = [301370776, 301371121, 301371133, id1, id2].filter(Boolean);
const t0 = Date.now();
const res = await Promise.all(ids.map(p => callOnce('take_screenshot', { pageId: p }, 60000)));
const total = Date.now() - t0;
const out = res.map((r, i) => {
  const img = r.content && r.content.find(x => x.type === 'image');
  const e = { pageId: ids[i], ms: r.ms };
  if (img) { const b = Buffer.from(img.data, 'base64'); fs.writeFileSync(path.join(OUT, 'par-' + ids[i] + '.png'), b); e.png = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; e.bytes = b.length; e.kind = b.readUInt32BE(0) === 0x89504e47 ? 'png' : 'other'; }
  else e.text = (r.content && r.content.map(x => x.text).join(' ') || r.error || '').slice(0, 200);
  return e;
});
console.log(JSON.stringify({ totalMs: total, results: out }));
setTimeout(() => process.exit(0), 300);
