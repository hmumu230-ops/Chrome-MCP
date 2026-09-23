// Phase 8: raw 304, in-flight SSE detail, h2 check, ws detail
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

// raw 304: send If-None-Match manually
await evalJs(pageId, `async () => (await fetch('/cache', { headers: { 'If-None-Match': '"v1"' } })).status`);
// SSE still streaming
await evalJs(pageId, `() => { window.__es = new EventSource('/sse'); return 'es-open'; }`);
await sleep(1200);
// h2 check: external fetch, look for protocol field
await evalJs(pageId, `async () => (await fetch('https://cdn.jsdelivr.net/npm/vue@2/package.json')).status`).catch(e => log('h2 fetch failed', e.message));
await sleep(400);
const list = await netList(pageId);
const r304 = list.requests.filter(r => r.url.includes('/cache')).pop();
const sse = list.requests.filter(r => r.url.includes('/sse')).pop();
const h2 = list.requests.filter(r => r.url.includes('jsdelivr')).pop();
P('raw 304 entry', r304);
P('in-flight SSE entry (mid-stream)', sse);
P('h2 entry — check for protocol field', h2);
if (r304) P('304 detail', await netGet(pageId, r304.reqid).then(d => ({ status: d.status, error: d.error, body: d.responseBody, rh: d.responseHeaders })));
if (sse) P('in-flight SSE detail', await netGet(pageId, sse.reqid).then(d => ({ status: d.status, error: d.error, body: d.responseBody === undefined ? '<absent>' : d.responseBody.slice(0, 100) })));
await evalJs(pageId, `() => { window.__es && window.__es.close(); return 1; }`);
