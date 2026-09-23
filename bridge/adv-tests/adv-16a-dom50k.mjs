// adv-16a — Massive DOM (50k elements): snapshot size/truncation/timeout,
// then interact with the LAST uid in the snapshot + check the true last
// element never got a uid (cap = 1500 countable lines in inject/dom.js).
// Secondary: verbose take_snapshot (full AX tree via CDP — uncapped path).
// Run: node adv-16a-dom50k.mjs
import { init, call, myTab, closeTab, bridgeMem, fmtBytes, line } from './adv16-lib.mjs';

await init('adv-16a');
const mem0 = bridgeMem();
console.log('== adv-16a: 50k-element DOM snapshot ==');
console.log('bridge mem before:', mem0 ? mem0.mb + ' MB (pid ' + mem0.pid + ')' : 'n/a');

const pageId = await myTab('-dom50k');
if (!pageId) { console.log('FATAL: cannot open tab'); process.exit(1); }
console.log('tab', pageId);

// Build 50k elements: 5 leading buttons (get uids), then 49984 divs with own
// text (>1 char so each counts toward the 1500-line cap), 10 trailing buttons;
// very last = button#adv16-last. Snapshot cap => only ~first 1500 lines emit.
const build = await call('evaluate_script', {
  pageId,
  function: `() => {
    const t0 = performance.now();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('button');
      b.textContent = 'head-btn-' + i;
      b.onclick = () => { window.__adv16Clicked = 'head-' + i; };
      frag.appendChild(b);
    }
    for (let i = 0; i < 49984; i++) {
      const d = document.createElement('div');
      d.textContent = 'item ' + i + ' pad';
      frag.appendChild(d);
    }
    for (let i = 0; i < 10; i++) {
      const b = document.createElement('button');
      b.textContent = 'tail-btn-' + i;
      frag.appendChild(b);
    }
    const last = document.createElement('button');
    last.id = 'adv16-last';
    last.textContent = 'LAST-ELEMENT';
    last.onclick = () => { window.__adv16Clicked = 'yes-last'; };
    frag.appendChild(last);
    document.body.innerHTML = '';
    document.body.appendChild(frag);
    return { built: document.body.querySelectorAll('*').length, ms: Math.round(performance.now() - t0) };
  }`,
});
line('build 50k DOM', build.ok, JSON.stringify(build.data).slice(0, 120) + ' ' + Math.round(build.ms) + 'ms');

// --- default (dom-mode) snapshot ---
let t0 = performance.now();
const snap = await call('take_snapshot', { pageId });
const snapMs = Math.round(snap.ms);
if (snap.ok) {
  const d = snap.data;
  const lines = d.lines || [];
  const uidLines = lines.filter(l => /^\s*\[/.test(l));
  const uidRe = /^\s*\[([^\]]+)\]/;
  const uids = uidLines.map(l => l.match(uidRe)[1]);
  console.log(`  snapshot: ${lines.length} lines, ${uids.length} uids, resp=${fmtBytes(snap.bytes)}, ${snapMs}ms`);
  line('snapshot truncation indicator present', 'truncated' in d || 'note' in d || 'hasMore' in d,
    'keys=' + Object.keys(d).join(','));
  line('last snapshot uid', true, uids[uids.length - 1]);
  // Is the real last element (button#adv16-last) reachable?
  const probe = await call('evaluate_script', {
    pageId,
    function: `() => {
      const last = document.getElementById('adv16-last');
      return { lastUidAttr: last ? last.getAttribute('data-mcp-uid') : null,
               totalTagged: document.querySelectorAll('[data-mcp-uid]').length };
    }`,
  });
  console.log('  page-side:', JSON.stringify(probe.data));
  // Click the LAST uid the snapshot emitted (the deepest reachable element).
  const lastUid = uids[uids.length - 1];
  const click = await call('click', { pageId, uid: lastUid });
  let verified = '';
  if (click.ok) {
    const chk = await call('evaluate_script', { pageId, function: '() => window.__adv16Clicked || null' });
    verified = 'clicked=' + JSON.stringify(chk.data && chk.data.result);
  }
  line('click last snapshot uid ' + lastUid, click.ok, click.ok ? verified : click.err);
  // Try interacting with a uid for the real last element — it never got one.
  // Forge the natural next uid? Instead prove cap: real last has no attr →
  // interaction impossible without uid. Also confirm stale-uid guard still fires.
  const bogus = await call('click', { pageId, uid: 'e999999' });
  line('click non-existent uid e999999 errors', !click.ok || !bogus.ok, bogus.err);
} else {
  line('take_snapshot on 50k DOM', false, snap.err + ' ' + Math.round(snapMs) + 'ms');
}

// --- verbose snapshot = full AX tree via CDP (UNCAPPED path) ---
console.log('  -- verbose (full AX tree, uncapped) --');
const v = await call('take_snapshot', { pageId, verbose: true });
if (v.ok) {
  const n = (v.data.lines || []).length;
  line('verbose snapshot', true, `${n} lines, resp=${fmtBytes(v.bytes)}, ${Math.round(v.ms)}ms`);
} else {
  line('verbose snapshot', false, v.err + ' ' + Math.round(v.ms) + 'ms');
}

const mem1 = bridgeMem();
console.log('bridge mem after:', mem1 ? mem1.mb + ' MB' : 'n/a', mem0 && mem1 ? '(delta ' + (mem1.ws - mem0.ws > 0 ? '+' : '') + ((mem1.ws - mem0.ws) / 1048576).toFixed(1) + ' MB)' : '');

await closeTab(pageId);
console.log('done — tab closed');
