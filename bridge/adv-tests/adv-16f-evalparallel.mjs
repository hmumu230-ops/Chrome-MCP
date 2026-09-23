// adv-16f — 5 parallel long-running evaluate_script calls (~10s busy loops)
// across 5 tabs. Checks: all return, wall time ~= 10s (true parallelism),
// bridge stays responsive mid-flight, SW survives. Closes all 5 tabs.
// Run: node adv-16f-evalparallel.mjs
import { init, call, myTab, closeTab, freshCaller, bridgeMem, fmtBytes, line } from './adv16-lib.mjs';

const N = 5, SECS = 10;
await init('adv-16f');
console.log(`== adv-16f: ${N} parallel ${SECS}s evaluates ==`);
const mem0 = bridgeMem();

const ids = [];
for (let i = 0; i < N; i++) {
  const id = await myTab('-par' + i);
  if (id) ids.push(id);
}
console.log('tabs:', ids.join(','));
if (!ids.length) { console.log('FATAL: no tabs'); process.exit(1); }

// independent caller to probe bridge responsiveness mid-flight
const probe = freshCaller('adv-16f-probe');
await probe.init();

const t0 = performance.now();
const mid = { ms: null, ok: null };
const probeTimer = setTimeout(async () => {
  const t = performance.now();
  const r = await probe.call('list_pages', {});
  mid.ms = Math.round(performance.now() - t);
  mid.ok = !!(r && !r.isError);
}, 4000);

const jobs = ids.map((id, k) => call('evaluate_script', {
  pageId: id,
  function: `() => {
    const end = Date.now() + ${SECS * 1000};
    let n = 0;
    while (Date.now() < end) { n += Math.sqrt(n % 97); }
    return { loops: Math.floor(n / 1e6) + 'M', i: ${k} };
  }`,
}).then(r => ({ id, ok: r.ok, ms: Math.round(r.ms), err: r.err, bytes: r.bytes })));

const results = await Promise.all(jobs);
clearTimeout(probeTimer);
const wall = Math.round(performance.now() - t0);

for (const r of results) console.log(`  tab ${r.id}: ok=${r.ok} callMs=${r.ms} resp=${fmtBytes(r.bytes)}${r.err ? ' ERR ' + r.err : ''}`);
line('all parallel evals ok', results.every(r => r.ok));
line('wall ~= one eval (true parallelism)', wall < SECS * 1000 * 2.5, `wall=${wall}ms vs serial~${SECS * N}s`);
line('bridge responsive mid-flight', mid.ok === true, `probe list_pages ${mid.ms}ms`);
console.log('SW alive after:', (await call('list_pages', {})).ok);

await probe.destroy();
for (const id of ids) await closeTab(id);
const mem1 = bridgeMem();
console.log(`bridge mem: ${mem0 ? mem0.mb : '?'} -> ${mem1 ? mem1.mb : '?'}MB`);
console.log('done — all tabs closed');
