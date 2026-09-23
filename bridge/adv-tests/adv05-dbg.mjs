import { init, call, evl } from './adv05-lib.mjs';
await init();
const lp = await call('list_pages', {});
let pages = []; try { pages = JSON.parse(lp.text); } catch {}
const act = pages.filter(p => p.active).map(p => `${p.pageId}:${p.title.slice(0, 40)}`);
console.log('ACTIVE TABS:', JSON.stringify(act));
console.log('my tab active?', pages.find(p => p.pageId === Number(process.argv[2]))?.active);
// is debugger attached? try a cheap probe: list_network_requests attaches if not — instead use console messages which attach too...
// better: evaluate something that reveals debug state indirectly — skip; just report.
process.exit(0);
