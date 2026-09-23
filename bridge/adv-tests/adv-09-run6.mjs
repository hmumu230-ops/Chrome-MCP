// Phase 5: filters, pagination, file output, navigation mid-capture
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

// --- filter: resourceTypes ---
const all = await netList(pageId);
P('total entries', all.total);
const byType = {};
for (const r of all.requests) byType[r.type] = (byType[r.type] || 0) + 1;
P('type histogram', byType);
const fetchOnly = await netList(pageId, { resourceTypes: ['Fetch'] });
P('filter Fetch', { total: fetchOnly.total, allFetch: fetchOnly.requests.every(r => r.type === 'Fetch'), types: [...new Set(fetchOnly.requests.map(r => r.type))] });
const xhrOnly = await netList(pageId, { resourceTypes: ['XHR'] });
P('filter XHR', { total: xhrOnly.total, types: [...new Set(xhrOnly.requests.map(r => r.type))] });
const imgOnly = await netList(pageId, { resourceTypes: ['Image'] });
P('filter Image', { total: imgOnly.total, urls: imgOnly.requests.map(r => r.url.slice(0, 40)) });
const wsOnly = await netList(pageId, { resourceTypes: ['websocket'] });
P('filter websocket', { total: wsOnly.total, entries: wsOnly.requests });
// bogus type
const bogus = await netList(pageId, { resourceTypes: ['BOGUS'] });
P('filter BOGUS', { total: bogus.total });

// --- method/url filters: NOT in schema — try passing anyway (extra args should be ignored by schema or rejected) ---
const mPost = await netList(pageId, { method: 'POST', urlPattern: 'post-echo' });
P('filter method=POST urlPattern=post-echo (unsupported args)', { total: mPost.total, note: 'if total==unfiltered, args were ignored' });

// --- pagination ---
const p1 = await netList(pageId, { pageSize: 5, pageIdx: 0 });
const p2 = await netList(pageId, { pageSize: 5, pageIdx: 1 });
P('pagination p1', { n: p1.requests.length, ids: p1.requests.map(r => r.reqid) });
P('pagination p2', { n: p2.requests.length, ids: p2.requests.map(r => r.reqid) });
const overlap = p1.requests.map(r => r.reqid).filter(id => p2.requests.map(x => x.reqid).includes(id));
P('pagination overlap', overlap);

// --- file output ---
const f1 = await netGet(pageId, 6, { responseFilePath: 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv09-out\\r6-body.json' });
P('get w/ responseFilePath', JSON.stringify(f1).slice(0, 600));
const f2 = await netGet(pageId, 9, { requestFilePath: 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv09-out\\r9-req.txt', responseFilePath: 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv09-out\\r9-res.json' });
P('get w/ requestFilePath+responseFilePath', JSON.stringify(f2).slice(0, 800));

// --- navigation mid-capture: start slow fetch then navigate away ---
await evalJs(pageId, `() => { window.__p = fetch('/slow?ms=3000').then(r => 'done').catch(e => 'ERR'); return 1; }`);
await sleep(400);
await evalJs(pageId, `() => { location.href = 'http://localhost:8125/?nav=' + Date.now(); return 1; }`);
await sleep(3000);
const postNav = await netList(pageId);
const stale = postNav.requests.filter(r => r.url.includes('/slow?ms=3000') || r.url.includes('/hang'));
P('after navigation mid-capture', { total: postNav.total, urls: postNav.requests.map(r => r.url.slice(-40)) });
P('stale entries still visible (slow/hang from prev loader)', stale.map(r => r.url));
