// adv-16z — safety net: close every tab whose URL carries the #adv16 marker.
// Run standalone or after any adv-16* test: node adv-16z-cleanup.mjs
import { init, call, status, sweepMarked, bridgeMem } from './adv16-lib.mjs';

await init('adv-16z');
const st = await status();
console.log(`bridge: sessions=${st.sessions} ext=${st.extensionConnected} mem=${(bridgeMem() || {}).mb}MB`);
const r = await sweepMarked();
console.log(`marked tabs found=${r.found} closed=${r.closed}${r.err ? ' ERR ' + r.err : ''}`);
const left = await call('list_pages', {});
const remaining = ((left.data && (left.data.items || left.data)) || []).filter(p => String(p.url || '').includes('#adv16'));
console.log(`remaining #adv16 tabs: ${remaining.length}`);
