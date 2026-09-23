// adv-16c — 30 tabs via new_page: timing, bridge memory delta (WorkingSet64
// of the listener PID on :7890), session count sanity, then close ALL.
// Run: node adv-16c-tabs30.mjs
import { init, call, status, bridgeMem, line } from './adv16-lib.mjs';

const N = 30;
await init('adv-16c');
console.log('== adv-16c: 30 tabs ==');

const st0 = await status();
const mem0 = bridgeMem();
console.log(`bridge: sessions=${st0.sessions} extConnected=${st0.extensionConnected} ws=${mem0 ? mem0.mb + 'MB' : 'n/a'} pid=${mem0 && mem0.pid}`);

const pages0 = await call('list_pages', {});
const baseTabs = (pages0.data && (pages0.data.items || pages0.data) || []).length;
console.log('pre-existing tabs:', baseTabs);

// open N tabs sequentially, timing each
const ids = [];
const times = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const r = await call('new_page', { url: `http://127.0.0.1:7890/#adv16-t30-${i}`, background: true });
  times.push(Math.round(performance.now() - t));
  if (r.ok && r.data && r.data.pageId) ids.push(r.data.pageId);
  else console.log(`  open #${i} FAILED: ${r.err}`);
}
const openMs = Math.round(performance.now() - t0);
const memMid = bridgeMem();
console.log(`opened ${ids.length}/${N} in ${openMs}ms — per-call min=${Math.min(...times)} med=${times.sort((a,b)=>a-b)[N>>1]} max=${Math.max(...times)}ms`);
console.log(`bridge mem after open: ${memMid ? memMid.mb + 'MB' : 'n/a'} (delta ${mem0 && memMid ? ((memMid.ws - mem0.ws) / 1048576).toFixed(1) + 'MB' : '?'})`);

const st1 = await status();
const pages1 = await call('list_pages', {});
const nowTabs = (pages1.data && (pages1.data.items || pages1.data) || []).length;
line('session count still sane', st1.sessions <= st0.sessions + 2, `sessions ${st0.sessions} -> ${st1.sessions} (one MCP session serves all tabs)`);
line('list_pages sees all new tabs', nowTabs === baseTabs + ids.length, `${baseTabs} -> ${nowTabs}`);

// hammer: one call per tab to prove they're all functional
const t1 = performance.now();
let okCnt = 0;
for (const id of ids) {
  const r = await call('evaluate_script', { pageId: id, function: '() => 1' });
  if (r.ok) okCnt++;
}
console.log(`eval on each of ${ids.length} tabs: ${okCnt} ok in ${Math.round(performance.now() - t1)}ms`);

// close ALL tabs we opened
const t2 = performance.now();
let closed = 0;
for (const id of ids) { const r = await call('close_page', { pageId: id }); if (r.ok) closed++; }
const closeMs = Math.round(performance.now() - t2);
const pages2 = await call('list_pages', {});
const endTabs = (pages2.data && (pages2.data.items || pages2.data) || []).length;
line('all opened tabs closed', closed === ids.length && endTabs === baseTabs, `closed=${closed}/${ids.length} tabs ${baseTabs}->${endTabs} in ${closeMs}ms`);

// give the bridge a moment to GC, then measure
await new Promise(r => setTimeout(r, 3000));
const memEnd = bridgeMem();
console.log(`bridge mem final: ${memEnd ? memEnd.mb + 'MB' : 'n/a'} (net delta vs start ${mem0 && memEnd ? ((memEnd.ws - mem0.ws) / 1048576).toFixed(1) + 'MB' : '?'})`);
const st2 = await status();
console.log(`final sessions=${st2.sessions}`);
console.log('done');
