// Edge-element screenshots on a fresh tab WITHOUT take_snapshot (frameMap empty
// -> checkUid passes -> exercises box() directly).
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11edge', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
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
function analyze(buf) {
  const magic = buf.subarray(0, 12).toString('hex');
  if (buf.readUInt32BE(0) === 0x89504e47) return { kind: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length, magic };
  return { kind: 'other', bytes: buf.length, magic };
}

await waitConnected(); await init();
const np = await call('new_page', { url: 'https://example.com/', background: true });
const m = np.txt.match(/"pageId":\s*(\d+)/);
const pid = Number(m[1]);
console.log('EDGETAB', pid);
await new Promise(r => setTimeout(r, 800));
// build edge DOM — no snapshot on this tab
const build = `() => {
  const d = document; d.body.innerHTML=''; d.documentElement.style.margin='0'; d.body.style.margin='0';
  for(let i=0;i<10;i++){const e=d.createElement('div');e.style.cssText='height:100px;background:#eee';e.textContent='r'+i;d.body.appendChild(e);}
  const mk=(css,tag,uidv,txt)=>{const e=d.createElement(tag||'div');e.style.cssText=css;e.setAttribute('data-mcp-uid',uidv);e.textContent=txt||'';d.body.appendChild(e);return e;};
  mk('display:none;position:absolute;left:50px;top:100px;width:150px;height:60px;background:#ff0000','button','edn','DN');
  mk('visibility:hidden;position:absolute;left:50px;top:300px;width:150px;height:60px;background:#0000ff','button','evh','VH');
  mk('position:absolute;left:50px;top:500px;width:0;height:0;padding:0;border:0;background:#123456','button','ezero','Z');
  mk('position:absolute;left:50px;top:600px;width:1px;height:1px;padding:0;border:0;background:#ff00ff','button','etiny','');
  mk('position:absolute;left:50px;top:700px;width:150px;height:60px;background:#00ffff','button','eok','OK-BTN');
  return {built:true, docH:document.documentElement.scrollHeight};
}`;
const ev = await call('evaluate_script', { pageId: pid, function: build });
console.log('BUILD', (ev.txt || '').slice(0, 200));
const shots = ['edn', 'evh', 'ezero', 'etiny', 'eok', 'bogus-uid-9'];
const out = [];
for (const u of shots) {
  const s = await call('take_screenshot', { pageId: pid, uid: u });
  const img = s.r && s.r.body.result && s.r.body.result.content && s.r.body.result.content.find(x => x.type === 'image');
  const ent = { uid: u };
  if (img) { const b = Buffer.from(img.data, 'base64'); fs.writeFileSync(path.join(OUT, 'edge-' + u + '.png'), b); Object.assign(ent, analyze(b)); }
  else ent.text = (s.txt || '').slice(0, 250);
  out.push(ent);
}
console.log(JSON.stringify(out, null, 0));
console.log('EDGEPAGEID=' + pid);
setTimeout(() => process.exit(0), 300);
