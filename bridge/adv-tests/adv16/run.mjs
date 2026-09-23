// adv-16 batch runner with retries (extension WS flaps when two browsers
// hold the same unpacked extension — calls race the ~300ms reconnect cycle,
// and the bridge occasionally dies mid-request; watchdog restarts it in ~5s).
// usage: node run.mjs <steps.json> <out.json>
// steps: [{ "name": "...", "tool": "...", "args": {...}, "retries": 12, "sleep": ms_after }]
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
let idc = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dataLine || t); } catch { return { raw: t }; }
}
const INFRA = /extension call timeout|extension disconnected|not connected|cannot attach debugger|No valid session/i;

async function initSession() {
  for (let i = 0; i < 30; i++) {
    try {
      sid = null;
      const init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv16', version: '0' } });
      if (!init.error && init.result) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

const [stepsFile, outFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const results = [];
if (!(await initSession())) { console.error('bridge never came up'); process.exit(1); }

for (const s of steps) {
  const max = s.retries ?? 12;
  let r, attempt = 0, ok = false;
  while (attempt < max) {
    attempt++;
    try {
      r = await req('tools/call', { name: s.tool, arguments: s.args || {} });
    } catch (e) {
      // transport died (bridge crash) — wait for watchdog restart, re-init, retry
      await sleep(6000);
      if (!(await initSession())) { console.error('bridge lost'); process.exit(1); }
      continue;
    }
    const txt = r?.result?.content?.[0]?.text ?? '';
    const isErr = r?.result?.isError || r?.error;
    if (r?.error && /session/i.test(String(r.error.message || ''))) {
      await initSession(); continue;
    }
    if (isErr && INFRA.test(txt) && attempt < max) { await sleep(500); continue; }
    ok = !isErr;
    break;
  }
  results.push({ name: s.name, tool: s.tool, attempts: attempt, ok, result: r?.result ?? r });
  console.log(`[${ok ? 'OK' : 'ERR'}] ${s.name} (${attempt} att)`);
  if (s.sleep) await sleep(s.sleep);
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log('wrote ' + outFile);
