// adv-13-shot.mjs — edge tests for take_screenshot.
// Covers: chrome:// tab, 20000px fullPage, below-viewport element, 0-size /
// display:none element, format/quality fuzz, uid+fullPage conflict, stale uid,
// parallel shots, shot-during-navigate, filePath magic bytes, detach/reattach.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:7890/mcp';
const OUT = 'D:\\Tool\\chrome-mcp\\bridge\\test-out';
fs.mkdirSync(OUT, { recursive: true });

let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(b),
  });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  return { msg: m[m.length - 1], status: r.status, raw: t.slice(0, 300) };
};
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });

// ---- helpers ----
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(5) + 's';
const rec = (n, sev, detail) => console.log(`[#${String(n).padStart(4)}] [${sev.padEnd(4)}] ${detail}   (t=${el()})`);

const tc = async (n, a) => { const s = Date.now(); const r = await call(n, a); return { r, ms: Date.now() - s }; };
const res = r => r?.msg?.result;
const isErr = r => !!res(r)?.isError;
const errText = r => (res(r)?.content?.[0]?.text || 'isError').replace(/\n/g, ' | ').slice(0, 240);
const imgB64 = r => { const c = res(r)?.content?.[0]; return c?.type === 'image' ? c.data : null; };
const mime = r => res(r)?.content?.[0]?.mimeType;
const sc = r => res(r)?.structuredContent;
const txtJson = r => { try { return JSON.parse(res(r)?.content?.[0]?.text || '{}'); } catch { return {}; } };
const sha = b64 => crypto.createHash('sha256').update(b64 || '').digest('hex').slice(0, 12);
const magic = b64 => { const b = Buffer.from(b64 || '', 'base64'); return [...b.subarray(0, 4)].map(x => x.toString(16).padStart(2, '0')).join(' '); };
const desc = r => isErr(r) ? 'err ' + errText(r) : imgB64(r) ? 'img ' + mime(r) + ' ' + magic(imgB64(r)) : 'resp ' + JSON.stringify(res(r)?.content?.[0]?.text || '').slice(0, 160);

// Minimal PNG decode: IHDR dims always; pixel unfilter only if `pixels` (skip on huge imgs).
function png(b64, pixels = true) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { err: 'not png', magic: magic(b64) };
  let pos = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len); pos += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const out = { w, h, bd, ct, bytes: buf.length };
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!pixels || !ch || bd !== 8) { out.note = 'dims only'; return out; }
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y ? img.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = img.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
  }
  out.frac = (r, g, b2, tol = 40) => {
    let hit = 0, tot = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const o = y * stride + x * ch; tot++;
      if (Math.abs(img[o] - r) < tol && Math.abs(img[o + 1] - g) < tol && Math.abs(img[o + 2] - b2) < tol) hit++;
    }
    return +(hit / tot).toFixed(3);
  };
  return out;
}
const colors = p => `red=${p.frac?.(255, 0, 0)} green=${p.frac?.(0, 255, 0)} blue=${p.frac?.(0, 0, 255)} cyan=${p.frac?.(0, 255, 255)} white=${p.frac?.(255, 255, 255)}`;

// ================= suite =================
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
setTimeout(() => { console.log('!! GLOBAL TIMEOUT'); process.exit(2); }, 215000);

const mine = [];
let A, B;

try {
  const np = await tc('new_page', { url: 'https://example.com' });
  A = sc(np.r)?.pageId ?? txtJson(np.r).pageId;
  mine.push(A);
  rec(0, 'INFO', `setup new_page example.com -> pageId=${A} (${np.ms}ms)`);

  // ---- 1. chrome://extensions tab ----
  const cb = await tc('new_page', { url: 'chrome://extensions/', background: true });
  B = sc(cb.r)?.pageId ?? txtJson(cb.r).pageId;
  if (isErr(cb.r) || !B) {
    rec(1, 'INFO', `new_page chrome://extensions failed at create: ${errText(cb.r)}`);
  } else {
    mine.push(B);
    const s1 = await tc('take_screenshot', { pageId: B });
    rec(1, isErr(s1.r) ? 'PASS' : 'FAIL', `chrome://ext BG tab shot (CDP path): ${desc(s1.r)} (${s1.ms}ms)`);
    await tc('select_page', { pageId: B });
    const s2 = await tc('take_screenshot', { pageId: B });
    rec(1.1, isErr(s2.r) ? 'PASS' : 'INFO', `chrome://ext ACTIVE tab shot (captureVisibleTab->fallback): ${desc(s2.r)} (${s2.ms}ms)`);
    await tc('select_page', { pageId: A });
  }

  // ---- inject tall page + colored buttons on A ----
  const inj = await tc('evaluate_script', {
    pageId: A, function: `() => {
      const mk=(id,css,txt)=>{const d=document.createElement('button');d.id=id;d.style.cssText=css;d.textContent=txt;document.body.appendChild(d);return d};
      const t=document.createElement('div');t.id='tall';t.style.cssText='height:20000px;width:100%';document.body.appendChild(t);
      mk('mark','position:absolute;top:5px;left:10px;width:100px;height:60px;background:rgb(0,0,255);border:0;padding:0','mark');
      mk('decoy','position:absolute;top:350px;left:10px;width:220px;height:220px;background:rgb(0,255,255);border:0;padding:0','decoy');
      mk('deep','position:absolute;top:30000px;left:10px;width:200px;height:200px;background:rgb(255,0,0);border:0;padding:0','deep');
      mk('zero','position:absolute;top:150px;left:300px;width:120px;height:80px;background:rgb(0,255,0);border:0;padding:0','zero');
      window.scrollTo(0,0);
      return JSON.stringify({sh:document.documentElement.scrollHeight, ih:innerHeight, dpr:devicePixelRatio});
    }` });
  rec(2, 'INFO', `injected: ${sc(inj.r)?.result ?? txtJson(inj.r).result}`);

  const snap = await tc('take_snapshot', { pageId: A });
  const uidOf = async id => sc((await tc('evaluate_script', { pageId: A, function: `() => document.getElementById('${id}')?.getAttribute('data-mcp-uid')` })).r)?.result;
  const [uDeep, uZero, uMark, uDecoy] = [await uidOf('deep'), await uidOf('zero'), await uidOf('mark'), await uidOf('decoy')];
  rec(2.1, 'INFO', `snapshot (${snap.ms}ms) uids: mark=${uMark} decoy=${uDecoy} deep=${uDeep} zero=${uZero}`);

  // ensure A is really the active tab (path selection depends on it)
  await tc('select_page', { pageId: A, bringToFront: true });
  const lp = await tc('list_pages', {});
  const aRow = (sc(lp.r)?.items || []).find(t => t.pageId === A);
  rec(2.2, 'INFO', `A active=${aRow?.active} url=${aRow?.url}`);

  // ---- 3. fullPage on ~30200px page ----
  const fp = await tc('take_screenshot', { pageId: A, fullPage: true });
  if (isErr(fp.r)) rec(3, 'FAIL', `fullPage 30200px: ${desc(fp.r)} (${fp.ms}ms)`);
  else {
    const p = png(imgB64(fp.r), false);
    rec(3, 'INFO', `fullPage 30200px: ${fp.ms}ms ${mime(fp.r)} img=${p.w}x${p.h} bytes=${p.bytes} — code caps clip h at 16384 (snapshot.js:56), actual img h=${p.h}`);
  }

  // ---- 4. element BELOW viewport (deep @ doc y=30000), then a 2nd shot now-scrolled ----
  const ds = await tc('take_screenshot', { pageId: A, uid: uDeep });
  const y1 = sc((await tc('evaluate_script', { pageId: A, function: '() => window.scrollY' })).r)?.result;
  if (isErr(ds.r)) rec(4, 'FAIL', `deep el shot: ${desc(ds.r)} (${ds.ms}ms)`);
  else {
    const p = png(imgB64(ds.r));
    rec(4, p.frac?.(255, 0, 0) > 0.5 ? 'PASS' : 'FAIL', `deep el shot (doc y=30000): ${ds.ms}ms ${p.w}x${p.h} ${colors(p)} scrollY->${y1} — clip used viewport rect while CDP reads doc coords?`);
  }
  // 4.1 control: mark is at doc top (y=5). box() scrolls back to top; doc vs viewport coords coincide.
  const ms = await tc('take_screenshot', { pageId: A, uid: uMark });
  if (isErr(ms.r)) rec(4.1, 'FAIL', `mark el shot: ${desc(ms.r)}`);
  else { const p = png(imgB64(ms.r)); rec(4.1, p.frac?.(0, 0, 255) > 0.5 ? 'PASS' : 'WARN', `mark el shot (doc y=5, blue): ${p.w}x${p.h} ${colors(p)}`); }

  // ---- 5. uid + fullPage together ----
  const uf = await tc('take_screenshot', { pageId: A, uid: uDeep, fullPage: true });
  if (isErr(uf.r)) rec(5, 'WARN', `uid+fullPage: ${desc(uf.r)} (${uf.ms}ms)`);
  else { const p = png(imgB64(uf.r)); rec(5, p.frac?.(255, 0, 0) > 0.5 ? 'INFO' : 'FAIL', `uid+fullPage(deep): ${p.w}x${p.h} ${colors(p)}`); }

  // ---- 6. stale uid ----
  const bad = await tc('take_screenshot', { pageId: A, uid: 'e9999' });
  rec(6, isErr(bad.r) ? 'PASS' : 'FAIL', `stale uid e9999: ${desc(bad.r)} (${bad.ms}ms)`);

  // ---- 7. 0-size then display:none ----
  await tc('evaluate_script', { pageId: A, function: `() => { const e=document.getElementById('zero'); e.style.width='0px'; e.style.height='0px'; return 1; }` });
  const zs = await tc('take_screenshot', { pageId: A, uid: uZero });
  rec(7, isErr(zs.r) ? 'PASS' : 'WARN', `0-size el: ${desc(zs.r)} (${zs.ms}ms)`);
  await tc('evaluate_script', { pageId: A, function: `() => { const e=document.getElementById('zero'); e.style.width='120px'; e.style.height='80px'; e.style.display='none'; return 1; }` });
  const dn = await tc('take_screenshot', { pageId: A, uid: uZero });
  rec(7.1, isErr(dn.r) ? 'PASS' : 'WARN', `display:none el: ${desc(dn.r)} (${dn.ms}ms)`);
  await tc('evaluate_script', { pageId: A, function: `() => { document.getElementById('zero').style.display=''; window.scrollTo(0,0); return 1; }` });

  // ---- 8. format fuzz ----
  const w = await tc('take_screenshot', { pageId: A, format: 'webp' });
  rec(8, isErr(w.r) ? 'WARN' : 'PASS', `format webp (CDP path): ${desc(w.r)} (${w.ms}ms)`);
  const bg = await tc('take_screenshot', { pageId: A, format: 'bogus' });
  rec(8.1, 'INFO', `format bogus ACTIVE tab: ${desc(bg.r)} (${bg.ms}ms) — silently coerced?`);
  const bg2 = await tc('take_screenshot', { pageId: A, format: 'bogus', uid: uMark });
  rec(8.2, isErr(bg2.r) ? 'PASS' : 'WARN', `format bogus via CDP: ${desc(bg2.r)} (${bg2.ms}ms)`);

  // ---- 9. quality fuzz ----
  for (const q of [-5, 200, 'x', 50]) {
    const qs = await tc('take_screenshot', { pageId: A, format: 'jpeg', quality: q });
    rec(9, 'INFO', `jpeg quality=${JSON.stringify(q)} ACTIVE tab: ${desc(qs.r)} (${qs.ms}ms)`);
  }
  for (const q of [-5, 200]) {
    const qs = await tc('take_screenshot', { pageId: A, format: 'jpeg', quality: q, uid: uMark });
    rec(9.1, 'INFO', `jpeg quality=${q} via CDP uid: ${desc(qs.r)} (${qs.ms}ms)`);
  }

  // ---- 10. 5 parallel screenshots (verify A still active -> captureVisibleTab path) ----
  const lp2 = await tc('list_pages', {});
  const aRow2 = (sc(lp2.r)?.items || []).find(t => t.pageId === A);
  rec(10.0, 'INFO', `pre-parallel A.active=${aRow2?.active}`);
  const par = await Promise.all([...Array(5)].map(() => tc('take_screenshot', { pageId: A })));
  par.forEach((x, k) => rec(10, isErr(x.r) ? 'FAIL' : 'INFO', `parallel[${k}]: ${desc(x.r)} sha=${sha(imgB64(x.r))} (${x.ms}ms)`));
  const okN = par.filter(x => !isErr(x.r) && imgB64(x.r)).length;
  rec(10.9, okN === 5 ? 'PASS' : 'FAIL', `parallel summary: ${okN}/5 images, distinct=${new Set(par.map(x => sha(imgB64(x.r)))).size}`);

  // ---- 11. shot while navigating ----
  const [sn, nv] = await Promise.all([
    call('take_screenshot', { pageId: A }),
    call('navigate_page', { pageId: A, type: 'url', url: 'https://example.org/' }),
  ]);
  rec(11, 'INFO', `shot-during-navigate: shot=${desc(sn)} nav=${isErr(nv) ? 'err ' + errText(nv) : 'ok->' + (sc(nv)?.url || '')}`);
  const tN = Date.now();
  const [sf, nv2] = await Promise.all([
    call('take_screenshot', { pageId: A, fullPage: true }),
    call('navigate_page', { pageId: A, type: 'url', url: 'https://example.com/' }),
  ]);
  rec(11.1, 'INFO', `fullPage-during-navigate: shot=${desc(sf)} nav=${isErr(nv2) ? 'err ' + errText(nv2) : 'ok->' + (sc(nv2)?.url || '')} (${Date.now() - tN}ms wall)`);
  await tc('wait_for', { pageId: A, time: 500 });

  // ---- 12. filePath ----
  const f1 = `${OUT}\\adv13-a.png`, f2 = `${OUT}\\adv13-b.jpg`;
  const wf = await tc('take_screenshot', { pageId: A, filePath: f1 });
  const wj = await tc('take_screenshot', { pageId: A, format: 'jpeg', filePath: f2 });
  const hex = f => { try { return [...fs.readFileSync(f).subarray(0, 4)].map(x => x.toString(16).padStart(2, '0')).join(' '); } catch (e) { return 'READ FAIL ' + e.message; } };
  rec(12, 'INFO', `filePath png: resp=${desc(wf.r)} | disk magic=${hex(f1)} (want 89 50 4e 47)`);
  rec(12.1, 'INFO', `filePath jpeg: resp=${desc(wj.r)} | disk magic=${hex(f2)} (want ff d8)`);

  // ---- 13. detach / reattach ----
  const at1 = await tc('take_screenshot', { pageId: A, fullPage: true });
  const d1 = await tc('detach_debugger', { pageId: A });
  const at2 = await tc('take_screenshot', { pageId: A, fullPage: true });
  rec(13, !isErr(at2.r) ? 'PASS' : 'FAIL', `fp(${at1.ms}ms,${isErr(at1.r) ? 'ERR' : 'ok'}) -> detach(${JSON.stringify(sc(d1.r) ?? txtJson(d1.r))}) -> fp again: ${desc(at2.r)} (${at2.ms}ms)`);
  const [rS, rD] = await Promise.allSettled([
    call('take_screenshot', { pageId: A, fullPage: true }),
    call('detach_debugger', { pageId: A }),
  ]);
  rec(13.1, 'INFO', `shot||detach race: shot=${rS.status === 'fulfilled' ? desc(rS.value) : 'REJ ' + rS.reason} detach=${rD.status === 'fulfilled' ? JSON.stringify(sc(rD.value) ?? txtJson(rD.value)) : 'REJ ' + rD.reason}`);
  const d2 = await tc('detach_debugger', { pageId: A });
  rec(13.2, 'INFO', `post-race detach: ${JSON.stringify(sc(d2.r) ?? txtJson(d2.r))} (detached:true=session lingered, false=clean)`);

  const d3 = await tc('detach_debugger', { pageId: A });
  rec(14, 'INFO', `final detach A: ${JSON.stringify(sc(d3.r) ?? txtJson(d3.r))}`);

} catch (e) {
  rec(99, 'FAIL', 'suite exception: ' + (e && e.stack || e));
} finally {
  for (const p of mine) { try { await call('detach_debugger', { pageId: p }); await call('close_page', { pageId: p }); } catch {} }
  console.log(`\nDone in ${((Date.now() - T0) / 1000).toFixed(1)}s. Closed tabs: ${mine.join(',')}`);
}
