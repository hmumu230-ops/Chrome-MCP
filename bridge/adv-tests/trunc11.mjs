// Truncation flag test at dpr=1: emulate viewport dsf=1, docH=20000 -> clip 16384
// dev px = at cap -> should succeed -> does response report truncated?
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11tr', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
    catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}
async function call(tool, args, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, 50000);
      if (r.status === 404) { await init(); continue; }
      const c = r.body && r.body.result && r.body.result.content;
      const txt = c && c.map(x => x.text || `[${x.type}]`).join('\n');
      if (r.body.result && r.body.result.isError && /not connected|disconnected|extension call timeout/i.test(txt || '')) { await waitConnected(60000); continue; }
      return { r, txt };
    } catch { await waitConnected(60000); }
  }
  return { txt: 'all tries failed' };
}
const pageId = Number(process.argv[2]);
await waitConnected(); await init();
// dsf=1 via emulate; restore docH=20000
console.log('emulate', JSON.stringify((await call('emulate', { pageId, viewport: '1536x800x1' })).txt || '').slice(0, 200));
const ev = await call('evaluate_script', { pageId, function: `() => { const d=document; d.body.innerHTML=''; d.documentElement.style.margin='0'; d.body.style.margin='0'; for(let i=0;i<200;i++){const e=d.createElement('div');e.style.cssText='height:100px;background:'+(i%2?'#ddd':'#eee');e.textContent='r'+i;d.body.appendChild(e);} return {docH:document.documentElement.scrollHeight,dpr:devicePixelRatio}; }` });
console.log('build', (ev.txt || '').slice(0, 200));
await new Promise(r => setTimeout(r, 400));
// inline image
const s1 = await call('take_screenshot', { pageId, fullPage: true });
const img1 = s1.r && s1.r.body.result && s1.r.body.result.content && s1.r.body.result.content.find(x => x.type === 'image');
const e1 = { inline: {} };
if (img1) { const b = Buffer.from(img1.data, 'base64'); e1.inline.png = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; e1.inline.bytes = b.length; }
else e1.inline.err = (s1.txt || '').slice(0, 200);
// structuredContent / extra fields present?
e1.inline.structuredKeys = s1.r && s1.r.body.result && s1.r.body.result.structuredContent ? Object.keys(s1.r.body.result.structuredContent) : null;
e1.inline.contentTypes = s1.r && s1.r.body.result && s1.r.body.result.content ? s1.r.body.result.content.map(x => x.type) : null;
e1.inline.rawText = (s1.txt || '').slice(0, 300);
// filePath variant
const fp = path.join(OUT, 'trunc-fp.png').replace(/\\/g, '\\\\');
const s2 = await call('take_screenshot', { pageId, fullPage: true, filePath: JSON.parse('"' + fp + '"') });
e1.filePathResp = (s2.txt || '').slice(0, 500);
// cleanup: restore real viewport
await call('emulate', { pageId, viewport: '' });
console.log(JSON.stringify(e1));
setTimeout(() => process.exit(0), 300);
