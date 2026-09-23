// Batch MCP runner: one session, sequential tool calls, per-call timeout + retry.
// usage: node batch.js <steps.json>   — steps: [{tool, args, label?}, ...]
//        node batch.js - '<inline-json>'
// Redacts cookie values. Prints one compact block per step.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT || 25000);
const RETRIES = Number(process.env.RETRIES || 1);

async function post(body, sid, timeoutMs) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) h['mcp-session-id'] = sid;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let res;
  try { res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal }); }
  catch (e) { clearTimeout(t); return { err: 'fetch: ' + (e.name === 'AbortError' ? 'timeout' : e.message) }; }
  const nsid = res.headers.get('mcp-session-id');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('readtimeout')), timeoutMs || 30000)),
      ]);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        try {
          const j = JSON.parse(l.slice(5).trim());
          if (j && j.id !== undefined) { reader.cancel().catch(() => {}); clearTimeout(t); return { j, sid: nsid, status: res.status }; }
        } catch {}
      }
    }
  } catch (e) { clearTimeout(t); reader.cancel().catch(() => {}); return { err: 'read: ' + e.message, status: res.status, partial: buf.slice(0, 300) }; }
  clearTimeout(t);
  try { return { j: JSON.parse(buf), sid: nsid }; } catch { return { raw: buf.slice(0, 500), sid: nsid, status: res.status }; }
}

function redact(o) {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'value' && typeof v === 'string' && v.length > 3) out[k] = `<redacted len=${v.length}>`;
      else if (k === 'body' && typeof v === 'string' && v.length > 600) out[k] = v.slice(0, 600) + `...[${v.length}B]`;
      else out[k] = redact(v);
    }
    return out;
  }
  return o;
}
function summarize(res) {
  let r = res;
  if (r && r.j) r = r.j.result ?? r.j;
  if (r && r.content) {
    const t = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
    return { isError: !!r.isError, data: redact(parsed) };
  }
  return redact(r);
}

let stepsSrc = process.argv[2];
const steps = stepsSrc === '-' ? JSON.parse(process.argv[3]) : JSON.parse(fs.readFileSync(stepsSrc, 'utf8'));

const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv12batch', version: '0' } } });
if (!init.j || init.j.error) { console.log('INIT FAIL', JSON.stringify(init).slice(0, 500)); process.exit(1); }
const sid = init.sid;
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 5000).catch(() => {});

let idc = 10;
for (const s of steps) {
  let out = null, ms = 0;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const t0 = Date.now();
    const r = await post({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name: s.tool, arguments: s.args || {} } }, sid, CALL_TIMEOUT);
    ms = Date.now() - t0;
    if (r.err) { out = { err: r.err }; continue; }
    const sum = summarize(r);
    // retry on transient extension-channel failures
    const txt = JSON.stringify(sum.data ?? '');
    if (sum.isError && /extension call timeout|not connected|no such page/.test(txt) && attempt < RETRIES) { out = sum; continue; }
    out = sum;
    break;
  }
  if (s.pick && out && out.data && typeof out.data === 'object') {
    const p = {};
    for (const k of s.pick) p[k] = out.data[k];
    out = { ...out, data: p };
  }
  const str = JSON.stringify(out, null, 0);
  console.log(`### ${s.label || s.tool} [${ms}ms]\n${str.length > 2500 ? str.slice(0, 2500) + '…TRUNC' : str}\n`);
}
try { await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': sid } }); } catch {}
process.exit(0);
