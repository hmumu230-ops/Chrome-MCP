// adv-16g — 10k console.* flood: capture buffer must stay bounded
// (MAX_CONSOLE=2000 in extension), bridge/SW memory sane, list output sane.
// Run: node adv-16g-console10k.mjs
import { init, call, myTab, closeTab, bridgeMem, fmtBytes, line } from './adv16-lib.mjs';

const N = 10000;
await init('adv-16g');
console.log('== adv-16g: 10k console flood ==');
const mem0 = bridgeMem();

const pageId = await myTab('-console');
if (!pageId) { console.log('FATAL: cannot open tab'); process.exit(1); }

// attach debugger + Runtime/Log first
const pre = await call('list_console_messages', { pageId });
line('attach + initial list', pre.ok, `total=${pre.ok ? pre.data.total : pre.err}`);

const t0 = performance.now();
const flood = await call('evaluate_script', {
  pageId,
  function: `() => {
    const t0 = performance.now();
    for (let i = 0; i < ${N}; i++) console.log('adv16 msg ' + i + ' ' + 'x'.repeat(20));
    return { ms: Math.round(performance.now() - t0) };
  }`,
});
line('10k console.log page-side', flood.ok, JSON.stringify(flood.ok ? flood.data.result : flood.err) + ` call=${Math.round(flood.ms)}ms`);

// CDP events keep arriving after the eval returns — poll until stable
let lastTotal = -1, stableMs = 0;
const drain0 = performance.now();
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 500));
  const l = await call('list_console_messages', { pageId, pageSize: 1 });
  if (l.ok && l.data.total === lastTotal) { stableMs = Math.round(performance.now() - drain0); break; }
  lastTotal = l.ok ? l.data.total : -1;
}
console.log(`  drained/stable after ~${stableMs}ms (last total=${lastTotal})`);

const lst = await call('list_console_messages', { pageId });
if (lst.ok) {
  const d = lst.data;
  const msgs = d.messages || [];
  line('console buffer capped at 2000', d.total <= 2000, `total=${d.total} (cap 2000) returned=${msgs.length} resp=${fmtBytes(lst.bytes)} ${Math.round(lst.ms)}ms`);
  const last = msgs[msgs.length - 1];
  console.log('  last msg:', JSON.stringify(last).slice(0, 160));
} else line('list_console_messages', false, lst.err);

// SW + bridge still alive?
const alive = await call('list_pages', {});
line('SW/bridge alive after flood', alive.ok);

const mem1 = bridgeMem();
console.log(`bridge mem: ${mem0 ? mem0.mb : '?'}MB -> ${mem1 ? mem1.mb : '?'}MB (delta ${mem0 && mem1 ? ((mem1.ws - mem0.ws) / 1048576).toFixed(1) + 'MB' : '?'})`);

await closeTab(pageId);
console.log('done — tab closed');
