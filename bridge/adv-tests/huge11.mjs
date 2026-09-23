// Oversized element (bigger than viewport): uid shot vs uid+fullPage shot.
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11h', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
async function call(tool, args, tries = 5) {
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
function topColors(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), ct = buf[25];
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const idat = []; let off = 8;
  while (off + 8 <= buf.length) { const len = buf.readUInt32BE(off); const ty = buf.toString('ascii', off + 4, off + 8); if (ty === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len)); if (ty === 'IEND') break; off += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(stride * h); let pos = 0;
  for (let y = 0; y < h; y++) { const f = raw[pos++]; for (let x = 0; x < stride; x++) {
    const a = x >= ch ? px[y * stride + x - ch] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0, c = (x >= ch && y > 0) ? px[(y - 1) * stride + x - ch] : 0;
    let v = raw[pos++];
    if (f === 1) v = (v + a) & 255; else if (f === 2) v = (v + b) & 255; else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    px[y * stride + x] = v;
  } }
  const counts = new Map(); const step = Math.max(1, Math.floor(w * h / 200000)); let n = 0;
  for (let i = 0; i < w * h; i += step) { const o = i * ch; const k = (px[o] << 16) | ((ch > 1 ? px[o + 1] : px[o]) << 8) | (ch > 2 ? px[o + 2] : px[o]); counts.set(k, (counts.get(k) || 0) + 1); n++; }
  return { w, h, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => '#' + k.toString(16).padStart(6, '0') + ' ' + Math.round(c * 1000 / n) / 10 + '%') };
}
await waitConnected(); await init();
const np = await call('new_page', { url: 'https://example.com/', background: false });
const pid = Number(np.txt.match(/"pageId":\s*(\d+)/)[1]);
// wait until body text present => document fully built/loaded
const wf = await call('wait_for', { pageId: pid, text: ['Example Domain'], timeout: 30000 });
console.log('READY', (wf.txt || '').slice(0, 150));
const rs = await call('evaluate_script', { pageId: pid, function: '() => document.readyState' });
console.log('RSTATE', (rs.txt || '').slice(0, 100));
const ev = await call('evaluate_script', { pageId: pid, function: `() => { const d=document; if(!d.body) return {nobody:true}; d.body.innerHTML=''; d.documentElement.style.margin='0'; d.body.style.margin='0'; const e=d.createElement('div'); e.setAttribute('data-mcp-uid','huge1'); e.style.cssText='position:absolute;left:0;top:0;width:3000px;height:2000px;background:#ff0000'; d.body.appendChild(e); const n=d.createElement('button'); n.setAttribute('data-mcp-uid','norm1'); n.style.cssText='position:absolute;left:10px;top:10px;width:100px;height:100px;background:#0000ff'; n.textContent='N'; d.body.appendChild(n); return {ok:true, has: !!d.querySelector('[data-mcp-uid=huge1]'), rect: JSON.parse(JSON.stringify(e.getBoundingClientRect()))}; }` });
console.log('EV', (ev.txt || '').slice(0, 400));
const out = {};
for (const [name, args] of [['norm-uid', { uid: 'norm1' }], ['huge-uid', { uid: 'huge1' }], ['huge-uid-fp', { uid: 'huge1', fullPage: true }]]) {
  const s = await call('take_screenshot', { pageId: pid, ...args });
  const img = s.r && s.r.body.result && s.r.body.result.content && s.r.body.result.content.find(x => x.type === 'image');
  if (img) { const b = Buffer.from(img.data, 'base64'); fs.writeFileSync(path.join(OUT, name + '.png'), b); out[name] = topColors(b); }
  else out[name] = (s.txt || '').slice(0, 200);
}
// cleanup
await call('close_page', { pageId: pid });
console.log(JSON.stringify(out));
setTimeout(() => process.exit(0), 300);
