// adv16 shared helpers — session mgmt, tool calls, bridge memory, tab cleanup.
// Every tab created by adv-16 tests uses a URL containing "#adv16" so the
// sweeper (adv-16z-cleanup.mjs) can find and close stragglers.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BASE = 'http://127.0.0.1:7890/mcp';
export const ROOT = 'http://127.0.0.1:7890/';
export const MARK = '#adv16';

// Persisted session id — the bridge caps at 50 sessions with 45min TTL, so
// all adv-16 scripts reuse ONE session instead of leaking a new one per run.
const SID_FILE = path.join(os.tmpdir(), 'adv16-sid.txt');

let sid = null;
let seq = 0;

export async function rpc(body) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sid ? { 'mcp-session-id': sid } : {}),
  };
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    return { status: 0, error: String(e && e.message || e), ms: performance.now() - t0, bytes: 0 };
  }
  const text = await res.text();
  if (!sid) sid = res.headers.get('mcp-session-id');
  const msgs = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {} }
  }
  if (!msgs.length && text.trim().startsWith('{')) { try { msgs.push(JSON.parse(text)); } catch {} }
  return { status: res.status, sid: res.headers.get('mcp-session-id'), msg: msgs[msgs.length - 1], ms: performance.now() - t0, bytes: text.length, rawText: text };
}

export async function init(name = 'adv-16') {
  // Try the persisted session first — avoids adding to the 50-session table.
  try { sid = fs.readFileSync(SID_FILE, 'utf8').trim() || null; } catch { sid = null; }
  if (sid) {
    const probe = await rpc({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'list_pages', arguments: {} } });
    if (probe.status === 200 && probe.msg && probe.msg.result) return sid; // reused
    sid = null;
  }
  // Session cap is 50 with 45min TTL — under concurrent load we may get 503;
  // retry for a while since testers' sessions free up as processes exit.
  const deadline = Date.now() + 120000;
  for (;;) {
    const r = await rpc({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '0' } } });
    if (r.sid) {
      await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
      try { fs.writeFileSync(SID_FILE, r.sid); } catch {}
      return r.sid;
    }
    if ((r.status !== 503 && r.status !== 0) || Date.now() > deadline) throw new Error('no session id (status ' + r.status + ') ' + (r.error || ''));
    await new Promise(res => setTimeout(res, 3000));
  }
}

// Fresh parallel session (for testing concurrency while another call is in-flight).
export function freshCaller(name) {
  let s2 = null, i2 = 0;
  const post = async (b) => {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(s2 ? { 'mcp-session-id': s2 } : {}) };
    const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(b) });
    const t = await r.text();
    if (!s2) s2 = r.headers.get('mcp-session-id');
    const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    return m[m.length - 1] || (t.trim().startsWith('{') ? JSON.parse(t) : null);
  };
  return {
    async call(n, a) {
      const r = await post({ jsonrpc: '2.0', id: ++i2, method: 'tools/call', params: { name: n, arguments: a || {} } });
      return r && r.result;
    },
    async init() {
      await post({ jsonrpc: '2.0', id: ++i2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '0' } } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async destroy() {
      if (!s2) return;
      const h = { 'mcp-session-id': s2 };
      try { await fetch(BASE, { method: 'DELETE', headers: h }); } catch {}
    },
  };
}

export async function call(name, args) {
  const r = await rpc({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args || {} } });
  const res = r.msg && r.msg.result;
  if (!res) return { ok: false, err: `no result (http ${r.status}) ${r.msg && r.msg.error ? JSON.stringify(r.msg.error) : r.error || ''}`.trim(), ms: r.ms, bytes: r.bytes };
  const txt = (res.content && res.content[0] && res.content[0].text) || '';
  if (res.isError) return { ok: false, err: txt.replace(/^Error:\s*/, ''), ms: r.ms, bytes: r.bytes };
  let data = res.structuredContent;
  if (data === undefined) { try { data = JSON.parse(txt); } catch { data = txt; } }
  return { ok: true, data, ms: r.ms, bytes: r.bytes, raw: res };
}

export async function status() {
  try { const r = await fetch(ROOT); return await r.json(); } catch (e) { return { error: String(e) }; }
}

// Bridge PID + memory (Windows side).
export function bridgePid() {
  try {
    const out = execSync('netstat -ano | findstr LISTENING | findstr :7890', { encoding: 'utf8' });
    const m = out.trim().split(/\r?\n/)[0].trim().split(/\s+/);
    return Number(m[m.length - 1]);
  } catch { return null; }
}
export function bridgeMem() {
  const pid = bridgePid();
  if (!pid) return null;
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`, { encoding: 'utf8' }).trim();
    return { pid, ws: Number(out), mb: (Number(out) / 1048576).toFixed(1) };
  } catch { return { pid }; }
}

// Tab management with marker.
export async function myTab(extra = '') {
  const r = await call('new_page', { url: `http://127.0.0.1:7890/${MARK}${extra}`, background: true });
  return r.ok ? r.data.pageId : null;
}
export async function closeTab(pageId) {
  if (!pageId) return;
  await call('close_page', { pageId }).catch(() => {});
}
export async function sweepMarked() {
  const r = await call('list_pages', {});
  if (!r.ok) return { closed: 0, err: r.err };
  const pages = r.data.items || r.data || [];
  const mine = pages.filter(p => String(p.url || '').includes(MARK));
  let closed = 0;
  for (const p of mine) { const c = await call('close_page', { pageId: p.pageId }); if (c.ok) closed++; }
  return { found: mine.length, closed };
}

export function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
export function line(name, cond, extra = '') {
  console.log(`  ${cond === true ? 'PASS' : cond === false ? 'FAIL' : 'INFO'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
}
