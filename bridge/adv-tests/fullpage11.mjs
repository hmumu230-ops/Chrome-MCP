// fullPage matrix: rebuild DOM at various heights, shot each, report dims+truncation.
const BASE = 'http://127.0.0.1:7890/mcp';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
const OUT = path.join(os.tmpdir(), 'adv11');
fs.mkdirSync(OUT, { recursive: true });
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11fp', version: '0' } }, 1, 10000); if (r.status === 200) return true; if (r.status === 503) await new Promise(x => setTimeout(x, 2000)); else return false; }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
async function call(tool, args, perTryMs = 45000, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, perTryMs);
      const c = r.body && r.body.result && r.body.result.content;
      const txt = c && c.map(x => x.text || `[${x.type}]`).join('\n');
      if (r.body.result && r.body.result.isError && /not connected|disconnected|extension call timeout/i.test(txt || '')) { await waitConnected(60000); continue; }
      return { r, txt };
    } catch { await waitConnected(60000); }
  }
  return { txt: 'all tries failed' };
}
function pngWH(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

const pageId = Number(process.argv[2]);
await waitConnected();
await init();
const build = (n) => `() => { const d=document; d.body.innerHTML=''; d.documentElement.style.margin='0'; d.body.style.margin='0'; for(let i=0;i<${n};i++){const e=d.createElement('div');e.style.cssText='height:100px;background:'+(i%2?'#ddd':'#eee');e.textContent='r'+i;d.body.appendChild(e);} return document.documentElement.scrollHeight; }`;
const results = [];
for (const n of [100, 165, 200]) {
  const ev = await call('evaluate_script', { pageId, function: build(n) });
  const docH = ev.txt && ev.txt.match(/\d+/) && ev.txt.match(/"result":\s*(\d+)/);
  await new Promise(r => setTimeout(r, 300));
  const s = await call('take_screenshot', { pageId, fullPage: true });
  const img = s.r && s.r.body.result.content.find(x => x.type === 'image');
  const ent = { divs: n, docH: docH && docH[1] };
  if (img) {
    const buf = Buffer.from(img.data, 'base64');
    fs.writeFileSync(path.join(OUT, `fp${n}.png`), buf);
    ent.png = pngWH(buf); ent.bytes = buf.length;
    ent.truncatedFlag = /truncated/i.test(s.txt || '');
    ent.note = (s.txt || '').slice(0, 200);
  } else ent.error = (s.txt || '').slice(0, 200);
  results.push(ent);
}
console.log(JSON.stringify(results));
setTimeout(() => process.exit(0), 300);
