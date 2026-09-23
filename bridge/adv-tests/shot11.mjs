// Adversarial tester #11 — screenshot test harness (resilient version).
// usage:
//   node shot11.mjs call <pageId> <outname> '<json extra args>'
//   node shot11.mjs seq  <pageId> <N> '<json extra args>'
//   node shot11.mjs par  '<json [pageId,...]>' '<json extra>'
//   node shot11.mjs eval <pageId> '<js function src>'
//   node shot11.mjs tool <toolName> '<json args>'
//   node shot11.mjs shotbatch '<json [{name,pageId,args},...]>'   -> sequential batch
// Images written to %TEMP%\adv11\. Retries ride out ext-socket flaps.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

const BASE = 'http://127.0.0.1:7890/mcp';
const OUT = path.join(os.tmpdir(), 'adv11');
fs.mkdirSync(OUT, { recursive: true });
let sid = null;
let reqId = 100;

async function httpStatus() {
  try {
    const r = await fetch('http://127.0.0.1:7890/', { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch { return null; }
}
async function waitConnected(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await httpStatus();
    if (s && s.extensionConnected) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 2000));
  }
  return -1;
}

async function rawReq(method, params, id, timeoutMs) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: t }; }
}

async function init() {
  for (let att = 0; att < 40; att++) {
    try {
      const r = await rawReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11', version: '0' } }, 1, 10000);
      if (r.status === 200) return true;
      if (r.status === 503) { await new Promise(x => setTimeout(x, 2000)); continue; }
      return false;
    } catch { await new Promise(x => setTimeout(x, 1500)); }
  }
  return false;
}

// call with client-side timeout + retry on transport-level failures.
// MCP-level errors (isError:true) are returned, not retried unless they look like socket flaps.
async function call(tool, args, opts = {}) {
  const perTry = opts.perTryMs || 35000;
  const tries = opts.tries || 4;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const r = await rawReq('tools/call', { name: tool, arguments: args }, ++reqId, perTry);
      if (r.status === 404) { await init(); continue; } // bridge restarted → re-init session
      const txt = r.body && r.body.result && r.body.result.content && r.body.result.content.map(x => x.text || `[${x.type}]`).join('\n');
      const isErr = r.body && r.body.result && r.body.result.isError;
      // socket-flap / disconnect errors → retry; real tool errors → return as-is
      if (isErr && /not connected|disconnected|extension call timeout/i.test(txt || '')) {
        last = { status: r.status, elapsed: Date.now() - t0, text: txt, isError: true, retried: i + 1 };
        await waitConnected(60000);
        continue;
      }
      return { status: r.status, elapsed: Date.now() - t0, text: txt, isError: !!isErr, retried: i, body: r.body };
    } catch (e) {
      last = { status: 0, elapsed: Date.now() - t0, text: 'client timeout/err: ' + (e && e.message || e), isError: true, retried: i + 1 };
      await waitConnected(60000);
    }
  }
  return last;
}

// ---------- image decode ----------
function parsePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25];
  const info = { w, h, bitDepth, colorType };
  if (bitDepth !== 8) return { ...info, note: 'unsupported bitDepth ' + bitDepth };
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!ch) return { ...info, note: 'unsupported colorType ' + colorType };
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { ...info, note: 'inflate fail ' + e.message }; }
  const stride = w * ch;
  const px = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    if (f > 4) return { ...info, note: 'bad filter ' + f };
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (x >= ch && y > 0) ? px[(y - 1) * stride + x - ch] : 0;
      let v = raw[pos++];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      px[y * stride + x] = v;
    }
  }
  const counts = new Map();
  const step = Math.max(1, Math.floor((w * h) / 400000));
  let n = 0;
  for (let i = 0; i < w * h; i += step) {
    const o = i * ch;
    let r, g, b;
    if (colorType === 6 || colorType === 2) { r = px[o]; g = px[o + 1]; b = px[o + 2]; }
    else { r = g = b = px[o]; }
    const k = (r << 16) | (g << 8) | b;
    counts.set(k, (counts.get(k) || 0) + 1);
    n++;
  }
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([k, c]) => '#' + k.toString(16).padStart(6, '0') + ' ' + Math.round(c * 1000 / n) / 10 + '%');
  return { ...info, top };
}
function jpegDims(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const m = buf[off + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), sof: '0x' + m.toString(16) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return { note: 'no SOF' };
}
function analyze(buf) {
  const magic = buf.subarray(0, 12).toString('hex');
  let kind = 'unknown';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) kind = 'png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) kind = 'jpeg';
  else if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') kind = 'webp:' + buf.toString('ascii', 12, 16);
  const out = { kind, bytes: buf.length, magic };
  try {
    if (kind === 'png') Object.assign(out, parsePng(buf) || {});
    if (kind === 'jpeg') Object.assign(out, jpegDims(buf) || {});
  } catch (e) { out.decodeErr = String(e && e.message || e); }
  return out;
}

async function doShot(pageId, outname, extra) {
  const args = { pageId: Number(pageId), ...(extra || {}) };
  const r = await call('take_screenshot', args, { perTryMs: 40000, tries: 4 });
  const c = r && r.body && r.body.result && r.body.result.content;
  const img = c && c.find(x => x.type === 'image');
  const out = { name: outname, pageId: Number(pageId), elapsedMs: r.elapsed, retried: r.retried };
  if (img) {
    const buf = Buffer.from(img.data, 'base64');
    const ext = (img.mimeType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
    const fp = path.join(OUT, outname + '.' + ext);
    fs.writeFileSync(fp, buf);
    out.mime = img.mimeType;
    out.file = fp;
    Object.assign(out, analyze(buf));
  } else {
    out.text = (r.text || '').slice(0, 500);
    out.isError = r.isError;
    if (extra && extra.filePath) {
      if (fs.existsSync(extra.filePath)) {
        const buf = fs.readFileSync(extra.filePath);
        out.fileWritten = true;
        Object.assign(out, analyze(buf));
        out.file = extra.filePath;
      } else out.fileWritten = false;
    }
  }
  return out;
}

const [mode, ...rest] = process.argv.slice(2);
const wc = await waitConnected(120000);
if (wc < 0) { console.log(JSON.stringify({ fatal: 'extension never connected in 120s' })); process.exit(1); }
const inited = await init();
if (!inited) { console.log(JSON.stringify({ fatal: 'init failed' })); process.exit(1); }
const warmup = await call('list_pages', {}, { perTryMs: 20000, tries: 6 });
if (!warmup.body || !warmup.body.result || warmup.isError) {
  // keep trying — a dead socket right after connect can still eat the first call
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const w = await call('list_pages', {}, { perTryMs: 20000, tries: 2 });
    if (w.body && w.body.result && !w.isError) break;
    if (i === 9) { console.log(JSON.stringify({ fatal: 'extension unresponsive', last: w })); process.exit(1); }
  }
}
console.error(`[adv11] connected after ${wc}ms, warmup ok`);

try {
  if (mode === 'call') {
    const [pageId, outname, extraJson] = rest;
    console.log(JSON.stringify(await doShot(pageId, outname, extraJson ? JSON.parse(extraJson) : {})));
  } else if (mode === 'seq') {
    const [pageId, nStr, extraJson] = rest;
    const extra = extraJson ? JSON.parse(extraJson) : {};
    const res = [];
    for (let i = 0; i < Number(nStr); i++) res.push(await doShot(pageId, 'seq' + i, extra));
    console.log(JSON.stringify(res));
  } else if (mode === 'par') {
    const [idsJson, extraJson] = rest;
    const ids = JSON.parse(idsJson);
    const extra = extraJson ? JSON.parse(extraJson) : {};
    const res = await Promise.all(ids.map((p, i) => doShot(p, 'par' + i, extra).catch(e => ({ pageId: p, err: String(e) }))));
    console.log(JSON.stringify(res));
  } else if (mode === 'shotbatch') {
    let specSrc = rest[0];
    if (specSrc.startsWith('@file:')) specSrc = fs.readFileSync(specSrc.slice(6), 'utf8');
    const spec = JSON.parse(specSrc);
    const res = [];
    for (const s of spec) res.push(await doShot(s.pageId, s.name, s.args || {}));
    console.log(JSON.stringify(res));
  } else if (mode === 'eval') {
    const [pageId, src] = rest;
    const r = await call('evaluate_script', { pageId: Number(pageId), function: src });
    console.log(JSON.stringify({ elapsedMs: r.elapsed, retried: r.retried, isError: r.isError, text: (r.text || '').slice(0, 1500) }));
  } else if (mode === 'snapuids') {
    const [pageId] = rest;
    const r = await call('take_snapshot', { pageId: Number(pageId) }, { perTryMs: 40000, tries: 4 });
    const lines = (r.text || '').split('\n');
    const uidLines = lines.filter(l => /\[[^\]]+\]/.test(l) || /iframe|frameId/i.test(l));
    console.log(JSON.stringify({ elapsedMs: r.elapsed, retried: r.retried, isError: r.isError, count: uidLines.length, lines: uidLines }));
  } else if (mode === 'tool') {
    const [tool, argsJson] = rest;
    const r = await call(tool, argsJson ? JSON.parse(argsJson) : {});
    console.log(JSON.stringify({ elapsedMs: r.elapsed, retried: r.retried, isError: r.isError, text: (r.text || '').slice(0, 3000) }));
  }
} catch (e) {
  console.log(JSON.stringify({ harnessError: String(e && e.message || e) }));
}
setTimeout(() => process.exit(0), 300); // let fetch sockets settle before exit
