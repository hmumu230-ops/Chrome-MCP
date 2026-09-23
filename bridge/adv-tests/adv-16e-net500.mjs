// adv-16e — network capture under 500 page requests.
// Page lives on http://127.0.0.1:7890/#adv16-net (same-origin), fires 500
// fetch()es at GET / (tiny JSON). Capture buffer is capped at 2000 — 500
// stays under, so we measure REAL captured count + response size + timing.
// Run: node adv-16e-net500.mjs
import { init, call, myTab, closeTab, bridgeMem, fmtBytes, line } from './adv16-lib.mjs';

const N = 500;
await init('adv-16e');
console.log('== adv-16e: 500-request network capture ==');
const mem0 = bridgeMem();

const pageId = await myTab('-net');
if (!pageId) { console.log('FATAL: cannot open tab'); process.exit(1); }
console.log('tab', pageId);

// attach debugger + enable Network BEFORE the flood
const pre = await call('list_network_requests', { pageId });
line('attach + initial list', pre.ok, `total=${pre.ok ? pre.data.total : pre.err}`);

// fire N requests from the page
const fire = await call('evaluate_script', {
  pageId,
  function: `async () => {
    const t0 = performance.now();
    const jobs = [];
    for (let i = 0; i < ${N}; i++) {
      jobs.push(fetch('/?adv16net=' + i + '&_=' + Math.random(), { cache: 'no-store' }).then(r => r.text()).then(() => 1).catch(() => 0));
    }
    const res = await Promise.all(jobs);
    return { ok: res.reduce((a, b) => a + b, 0), ms: Math.round(performance.now() - t0) };
  }`,
});
line('500 fetches completed', fire.ok && fire.data.result.ok === N, JSON.stringify(fire.ok ? fire.data.result : fire.err) + ` call=${Math.round(fire.ms)}ms`);

// give CDP events a moment to drain
await new Promise(r => setTimeout(r, 1500));

const lst = await call('list_network_requests', { pageId });
if (lst.ok) {
  const d = lst.data;
  const arr = d.requests || (d.items) || [];
  const types = {};
  for (const r of arr) types[r.type] = (types[r.type] || 0) + 1;
  line('list_network_requests total', d.total >= N, `total=${d.total} returned=${arr.length} resp=${fmtBytes(lst.bytes)} ${Math.round(lst.ms)}ms types=${JSON.stringify(types)}`);
} else line('list_network_requests', false, lst.err);

// pagination sanity
const page0 = await call('list_network_requests', { pageId, pageSize: 50, pageIdx: 0 });
const page9 = await call('list_network_requests', { pageId, pageSize: 50, pageIdx: 9 });
line('pagination 50x10 covers', page0.ok && page9.ok && page0.data.requests.length === 50 && page9.data.requests.length === 50,
  `p0=${page0.ok ? page0.data.requests.length : 'ERR'} p9=${page9.ok ? page9.data.requests.length : 'ERR'}`);

// single request detail incl body
const one = await call('get_network_request', { pageId });
line('get_network_request latest', one.ok, one.ok ? `status=${one.data.status} bytes=${(one.data.responseBody || '').length} resp=${fmtBytes(one.bytes)}` : one.err);

const mem1 = bridgeMem();
console.log(`bridge mem: ${mem0 ? mem0.mb : '?'}MB -> ${mem1 ? mem1.mb : '?'}MB (delta ${mem0 && mem1 ? ((mem1.ws - mem0.ws) / 1048576).toFixed(1) + 'MB' : '?'})`);

await closeTab(pageId);
console.log('done — tab closed');
