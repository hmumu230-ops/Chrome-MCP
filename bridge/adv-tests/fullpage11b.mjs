// Probe the device-px boundary for fullPage: sweep div counts, report ok/-32000.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null, reqId = 0;
async function rawReq(method, params, id, timeoutMs = 45000) {
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
    try { const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11fpb', version: '0' } }, 1, 10000); if (r.status === 200) return true; await new Promise(x => setTimeout(x, 2000)); }
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
const pageId = Number(process.argv[2]);
const counts = process.argv.slice(3).map(Number); // e.g. 130 132 140
await waitConnected(); await init();
const out = [];
for (const n of counts) {
  const ev = await call('evaluate_script', { pageId, function: `() => { const d=document; d.body.innerHTML=''; d.documentElement.style.margin='0'; d.body.style.margin='0'; for(let i=0;i<${n};i++){const e=d.createElement('div');e.style.cssText='height:100px;background:'+(i%2?'#ddd':'#eee');d.body.appendChild(e);} return document.documentElement.scrollHeight; }` });
  const m = ev.txt && ev.txt.match(/(\d+)/);
  await new Promise(r => setTimeout(r, 400));
  const s = await call('take_screenshot', { pageId, fullPage: true });
  const img = s.r && s.r.body.result && s.r.body.result.content && s.r.body.result.content.find(x => x.type === 'image');
  const ent = { divs: n, docH: m && m[0], expectedDevPx: m && Math.round(m[0] * 1.25) };
  if (img) { const b = Buffer.from(img.data, 'base64'); ent.png = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; ent.truncatedInText = /truncated/i.test(JSON.stringify(s.r.body.result)); }
  else ent.error = (s.txt || '').slice(0, 120);
  out.push(ent);
}
console.log(JSON.stringify(out));
setTimeout(() => process.exit(0), 300);
