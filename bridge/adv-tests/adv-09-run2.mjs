// Phase 1b: with debugger attached, reload page → capture document/css/script/img
import { init, call, slim, netList, evalJs } from './adv-09.mjs';
await init();
const pageId = Number(process.argv[2]);
// attach already happened? call list once to be sure
await netList(pageId);
await evalJs(pageId, `() => { location.reload(); return 1; }`);
await new Promise(r => setTimeout(r, 3500));
const list = await netList(pageId);
console.log('TOTAL:', list.total);
for (const r of list.requests) console.log(JSON.stringify(r));
