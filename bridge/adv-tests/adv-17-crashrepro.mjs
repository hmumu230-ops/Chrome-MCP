// adv-17-crashrepro.mjs — spawn OUR OWN bridge on port 7891 (stderr piped) and
// hit it with the patterns seen around the production crashes:
//   A) WS upgrade flood (mimics the observed non-extension /ws spam)
//   B) parallel initialize floods
//   C) mixed: WS flood + init flood + DELETE churn
// If it exits non-zero, we captured the real stderr.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const BRIDGE = 'D:\\Tool\\chrome-mcp\\bridge\\index.js';
const PORT = 7891;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [BRIDGE], {
  cwd: 'D:\\Tool\\chrome-mcp\\bridge',
  env: { ...process.env, MCP_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '', exited = null;
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
child.on('exit', (c, s) => { exited = { c, s }; console.log(`!!! BRIDGE EXITED code=${c} sig=${s}`); });
await sleep(1200);
console.log('bridge up?', !exited, '| boot log:', out.replace(/\n/g, ' | ').slice(0, 200));

const health = () => fetch(`${BASE}/`).then(r => r.json()).catch(e => ({ error: e.message }));

// ---------- A: WS flood x200 (origin=none, rapid connect/destroy) ----------
console.log('\n--- A: 200x WS upgrade flood');
for (let i = 0; i < 200 && !exited; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.onopen = () => ws.close();
  ws.onerror = () => {};
  if (i % 40 === 39) await sleep(50);
}
await sleep(1500);
console.log('post-A:', JSON.stringify(await health()), 'exited=', JSON.stringify(exited));

// ---------- B: 60 parallel initialize ----------
console.log('\n--- B: 60x parallel initialize');
const inits = await Promise.all(Array.from({ length: 60 }, (_, i) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'crash', version: '0' } } }),
  }).then(r => r.status).catch(e => 'fetch:' + e.message)
));
const okInits = inits.filter(x => x === 200).length;
console.log('inits ok:', okInits, 'of', inits.length, '| exited=', JSON.stringify(exited));
await sleep(1500);
console.log('post-B:', JSON.stringify(await health()));

// ---------- C: init + immediate DELETE + WS flood interleaved ----------
console.log('\n--- C: init/DELETE churn + WS flood');
for (let i = 0; i < 30 && !exited; i++) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } } }),
  }).catch(() => null);
  const sid = r && r.headers.get('mcp-session-id');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.onerror = () => {};
  if (sid) fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => {});
}
await sleep(1500);
console.log('post-C:', JSON.stringify(await health()), 'exited=', JSON.stringify(exited));

// ---------- D: tools/call without extension (pending churn) ----------
console.log('\n--- D: 100x tools/call (extension absent -> fast rejects)');
const r0 = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'd', version: '0' } } }),
}).catch(() => null);
const sid0 = r0 && r0.headers.get('mcp-session-id');
if (sid0) {
  const calls = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid0 },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }),
    }).then(r => r.status).catch(e => 'fetch:' + e.message)
  ));
  console.log('call statuses:', JSON.stringify(calls.reduce((a, c) => { a[c] = (a[c] || 0) + 1; return a; }, {})));
}
await sleep(1500);
console.log('post-D:', JSON.stringify(await health()), 'exited=', JSON.stringify(exited));

console.log('\n================ RESULT ================');
if (exited) {
  console.log(`CRASHED code=${exited.c} sig=${exited.s}`);
  console.log('STDERR:', err.slice(0, 4000));
} else {
  console.log('bridge survived all stages');
  console.log('stderr so far:', err.slice(0, 2000) || '(none)');
}
child.kill();
process.exit(0);
