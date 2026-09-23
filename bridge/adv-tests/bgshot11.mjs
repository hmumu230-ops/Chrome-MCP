// Cold background-tab screenshot timing + follow-up shots.
const BASE = 'http://127.0.0.1:7890/mcp';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11bg', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
async function call(tool, args, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, 45000);
      if (r.status === 404) { await init(); continue; }
      const c = r.body && r.body.result && r.body.result.content;
      const txt = c && c.map(x => x.text || `[${x.type}]`).join('\n');
      if (r.body.result && r.body.result.isError && /not connected|disconnected|extension call timeout/i.test(txt || '')) { await waitConnected(60000); continue; }
      return { r, txt };
    } catch { await waitConnected(60000); }
  }
  return { txt: 'all tries failed' };
}
function pngWH(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

await waitConnected(); await init();
// create a BACKGROUND tab (never activated) — cold compositor
const np = await call('new_page', { url: 'https://example.com/', background: true });
const m = np.txt && np.txt.match(/"pageId":\s*(\d+)/);
const bgId = m && Number(m[1]);
console.log('BGTAB', bgId, np.txt.slice(0, 150));
await new Promise(r => setTimeout(r, 800)); // let it load in background
const out = [];
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const s = await call('take_screenshot', { pageId: bgId });
  const img = s.r && s.r.body.result && s.r.body.result.content && s.r.body.result.content.find(x => x.type === 'image');
  const ent = { shot: i, ms: Date.now() - t0 };
  if (img) { const b = Buffer.from(img.data, 'base64'); fs.writeFileSync(path.join(OUT, 'bg' + i + '.png'), b); ent.png = pngWH(b); ent.bytes = b.length; ent.mime = img.mimeType; }
  else ent.error = (s.txt || '').slice(0, 200);
  out.push(ent);
}
// verify the bg tab never became active
const chk = await call('evaluate_script', { pageId: bgId, function: '() => ({vis: document.visibilityState, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio})' });
out.push({ visCheck: (chk.txt || '').slice(0, 300) });
console.log(JSON.stringify(out));
setTimeout(() => process.exit(0), 300);
