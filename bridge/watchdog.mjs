// Chrome MCP bridge supervisor: keeps `node index.js` alive.
// - restarts on crash/exit with backoff (flap protection)
// - tees child stdout/stderr to bridge-supervisor.log
// - single instance: exits if the port is already served
// Usage: node watchdog.mjs   (normally launched hidden via run-hidden.vbs)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(dir, 'bridge-supervisor.log');
const PORT = Number(process.env.MCP_PORT || 7890);
const FLAP_WINDOW_MS = 30000;   // crashes inside this window count as flapping
const FLAP_LIMIT = 5;           // >5 crashes in 30s → back off hard
const FLAP_SLEEP_MS = 60000;
const GRACE_MS = 2000;          // clean exits restart quickly, crashes slower

let child = null;
let restarts = [];
let stopping = false;

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}

function portInUse() {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port: PORT });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

function tee(stream, tag) {
  stream.on('data', d => {
    const text = d.toString();
    process.stdout.write(text);
    try { fs.appendFileSync(LOG, text.split('\n').filter(Boolean).map(l => `[${new Date().toISOString()}] ${tag} ${l}`).join('\n') + '\n'); } catch {}
  });
}

async function start() {
  if (stopping) return;
  if (await portInUse()) {
    // Another bridge (or an old instance) already owns the port — don't fight it.
    log(`port ${PORT} already serving — exiting supervisor`);
    process.exit(0);
  }
  child = spawn(process.execPath, [path.join(dir, 'index.js')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  tee(child.stdout, '[out]');
  tee(child.stderr, '[err]');
  log(`bridge started pid=${child.pid}`);
  child.on('exit', (code, sig) => {
    child = null;
    if (stopping) return;
    const now = Date.now();
    restarts = restarts.filter(t => now - t < FLAP_WINDOW_MS);
    restarts.push(now);
    if (restarts.length > FLAP_LIMIT) {
      restarts = [];
      log(`flapping detected (${FLAP_LIMIT + 1} exits/${FLAP_WINDOW_MS / 1000}s) — pausing ${FLAP_SLEEP_MS / 1000}s`);
      setTimeout(start, FLAP_SLEEP_MS);
      return;
    }
    const wait = code === 0 ? GRACE_MS : 5000;
    log(`bridge exited code=${code} sig=${sig || '-'} — restart in ${wait}ms`);
    setTimeout(start, wait);
  });
  child.on('error', e => log('spawn error:', e.message));
}

function shutdown() {
  stopping = true;
  if (child) { try { child.kill(); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('supervisor up');
start();
