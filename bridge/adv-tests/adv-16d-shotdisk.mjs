// adv-16d — repeated take_screenshot with filePath: disk growth, per-file
// size vs returned size, overwrite semantics for non-repo paths, cleanup.
// Run: node adv-16d-shotdisk.mjs
import { init, call, myTab, closeTab, fmtBytes, line } from './adv16-lib.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'adv16-shots');
const N = 15;

await init('adv-16d');
console.log('== adv-16d: screenshot-to-disk x' + N + ' ==');

const pageId = await myTab('-shots');
if (!pageId) { console.log('FATAL: cannot open tab'); process.exit(1); }
// give the tab something non-trivial to render
await call('evaluate_script', { pageId, function: `() => { document.body.innerHTML = '<div style="width:400px;height:300px;background:linear-gradient(45deg,#f00,#00f)">shot-target</div>'.repeat(50); return 1; }` });

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const free0 = Number(execSync(`powershell -NoProfile -Command "(Get-PSDrive -Name ${DIR[0]}).Free"`, { encoding: 'utf8' }).trim());
let totalBytes = 0, writes = 0, fails = 0;
const times = [];
for (let i = 0; i < N; i++) {
  const fp = path.join(DIR, `shot-${i}.png`);
  const t = performance.now();
  const r = await call('take_screenshot', { pageId, filePath: fp, format: 'png' });
  times.push(Math.round(performance.now() - t));
  if (r.ok) {
    writes++;
    try { totalBytes += fs.statSync(fp).size; } catch {}
  } else { fails++; if (i < 3) console.log('  shot fail:', r.err); }
}
const free1 = Number(execSync(`powershell -NoProfile -Command "(Get-PSDrive -Name ${DIR[0]}).Free"`, { encoding: 'utf8' }).trim());
console.log(`wrote ${writes}/${N} files, sum=${fmtBytes(totalBytes)}, disk delta=${fmtBytes(free0 - free1)}, fails=${fails}`);
console.log(`per-shot ms: min=${Math.min(...times)} med=${times.sort((a, b) => a - b)[N >> 1]} max=${Math.max(...times)}`);
line('disk delta ~= file sum', Math.abs((free0 - free1) - totalBytes) < 65536, `delta=${free0 - free1} sum=${totalBytes}`);

// overwrite an existing non-repo file — allowed (guard only covers repo paths)
const fp = path.join(DIR, 'shot-0.png');
const ow = await call('take_screenshot', { pageId, filePath: fp, format: 'png' });
line('overwrite non-repo file allowed', ow.ok, ow.ok ? '' : ow.err);

// repo-internal overwrite guard sanity (existing file must be refused)
const repoFile = 'D:/Tool/chrome-mcp/bridge/index.js';
const guard = await call('take_screenshot', { pageId, filePath: repoFile, format: 'png' });
line('overwrite repo file refused', !guard.ok || /refus/i.test(JSON.stringify(guard)), JSON.stringify(guard.data || guard.err).slice(0, 140));

// cleanup
fs.rmSync(DIR, { recursive: true, force: true });
console.log('temp dir removed:', !fs.existsSync(DIR));
await closeTab(pageId);
console.log('done — tab closed, files deleted');
