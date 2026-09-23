// adv14 dialog/modal edge-case runner.
// usage: node run.mjs <steps.json> <outlog.txt>
// Steps: {name, tool, args, timeoutMs, await_:false, retry:<ms>, sleep:<ms>, collect:true, store:{VAR:'structuredContent.pageId'}}
// "$VAR" inside arg strings is substituted with stored values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const stepsFile = process.argv[2];
const outFile = process.argv[3];
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
let seq = 0;
const vars = {};

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  try { fs.appendFileSync(outFile, s + '\n'); } catch {}
}

async function rawReq(body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs + 5000);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  try {
    const res = await fetch(BASE, { method: 'POST', headers, signal: ac.signal, body: JSON.stringify(body) });
    if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
    const txt = await res.text();
    const dataLine = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
    try { return JSON.parse(dataLine || txt); } catch { return { raw: txt.slice(0, 500) }; }
  } finally { clearTimeout(t); }
}

async function init() {
  for (let i = 0; ; i++) {
    try {
      const r = await rawReq({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv14', version: '0' } } }, 10000);
      if (r && r.result) { log('init ok sid=' + (sid || '').slice(0, 8)); return true; }
      if (i % 10 === 0) log('init retry ' + i + ': ' + JSON.stringify(r).slice(0, 120));
    } catch (e) { if (i % 10 === 0) log('init retry ' + i + ' err: ' + e.message); }
    await new Promise(r => setTimeout(r, 2000));
  }
}

function sub(v) {
  if (typeof v === 'string') {
    const m = v.match(/^\$([A-Z_]+)$/);
    if (m) return vars[m[1]];
    return v.replace(/\$([A-Z_]+)/g, (_, k) => String(vars[k]));
  }
  if (Array.isArray(v)) return v.map(sub);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = sub(v[k]); return o; }
  return v;
}

async function call(step) {
  const name = step.name || step.tool;
  const t0 = Date.now();
  const timeoutMs = step.timeoutMs || 30000;
  try {
    const r = await rawReq({ jsonrpc: '2.0', id: ++seq + 100, method: 'tools/call', params: { name: step.tool, arguments: sub(step.args || {}) } }, timeoutMs);
    const ms = Date.now() - t0;
    const res = r.result ?? r;
    const isErr = res && res.isError;
    let text = '';
    if (res && res.content && res.content[0]) text = res.content[0].text || '';
    const sc = res && res.structuredContent ? ' SC=' + JSON.stringify(res.structuredContent).slice(0, 8000) : '';
    log(`${name}: ${isErr ? 'ERROR' : 'OK'} ${ms}ms :: ${text.slice(0, 1500)}${sc}`);
    return { ok: !isErr, ms, res };
  } catch (e) {
    const ms = Date.now() - t0;
    log(`${name}: TIMEOUT/CLIENT-ERR ${ms}ms :: ${e.name} ${e.message}`);
    return { ok: false, ms, err: e.message };
  }
}

async function callRetry(step, deadlineMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const r = await call(step);
    if (r.ok) return r;
    const txt = JSON.stringify(r.res || r.err || '');
    if (/extension call timeout|fetch failed|not connected|AbortError|aborted|disconnected|ECONNRESET|socket/i.test(txt)) {
      await new Promise(r2 => setTimeout(r2, 1500));
      continue;
    }
    return r;
  }
  log(`${step.name}: gave up after ${deadlineMs}ms`);
  return { ok: false, gaveUp: true };
}

function storeVars(step, r) {
  if (!step.store || !r || !r.res) return;
  for (const [k, p] of Object.entries(step.store)) {
    let cur = r.res;
    for (const part of p.split('.')) {
      if (cur && cur.structuredContent) { cur = cur.structuredContent; }
      if (cur && cur[part] !== undefined) cur = cur[part]; else { cur = undefined; break; }
    }
    if (cur === undefined) {
      // fall back: parse text content as JSON
      try { const t = JSON.parse(r.res.content[0].text); cur = t; for (const part of p.split('.')) cur = cur && cur[part]; } catch {}
    }
    if (cur !== undefined) { vars[k] = cur; log(`stored $${k} = ${JSON.stringify(cur).slice(0, 120)}`); }
  }
}

async function main() {
  const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
  await init();
  const inflight = new Map();
  for (const step of steps) {
    if (step.sleep) { await new Promise(r => setTimeout(r, step.sleep)); continue; }
    if (step.collect) {
      for (const [n, p] of inflight) {
        const r = await Promise.race([p, new Promise(res => setTimeout(() => res({ ok: false, ms: -1, err: 'still inflight' }), step.collectMs || 90000))]);
        log(`collected ${n}: ${r.ok ? 'OK' : 'FAIL'} ${r.ms}ms ${r.err || ''}`);
        if (r.ok) inflight.delete(n);
      }
      inflight.clear();
      continue;
    }
    const runner = (step.retry ? callRetry(step, step.retry) : call(step)).then(r => { storeVars(step, r); return r; });
    if (step.await_ === false) {
      inflight.set(step.name, runner);
      log(`${step.name}: fired (not awaiting)`);
    } else {
      await runner;
    }
  }
  for (const [n, p] of inflight) {
    const r = await Promise.race([p, new Promise(res => setTimeout(() => res({ ok: false, ms: -1, err: 'still inflight at end' }), 60000))]);
    log(`final collect ${n}: ${r.ok ? 'OK' : 'FAIL/STILL-INFLIGHT'} ${r.ms}ms ${r.err || ''}`);
  }
  log('ALL DONE');
}
main().catch(e => { log('FATAL ' + e.stack); process.exit(1); });
