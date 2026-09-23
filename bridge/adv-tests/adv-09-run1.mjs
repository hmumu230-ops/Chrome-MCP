// Phase 1: open test page, list initial requests (document/css/script/img/data:)
import { init, call, slim, netList } from './adv-09.mjs';
await init();
const pg = slim(await call('new_page', { url: 'http://localhost:8125/' }));
console.log('PAGE:', JSON.stringify(pg));
await new Promise(r => setTimeout(r, 2500));
const list = await netList(pg.pageId);
console.log('TOTAL:', list.total);
for (const r of list.requests) console.log(JSON.stringify(r));
