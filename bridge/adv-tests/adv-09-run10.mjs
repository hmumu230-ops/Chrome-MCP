// Phase 9: CORS preflight visibility, PUT/DELETE, pagination edge
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

const R = await evalJs(pageId, `async () => {
  const R = {};
  // cross-origin POST with JSON -> triggers preflight OPTIONS on 127.0.0.1 (different origin)
  R.preflight = await fetch('http://127.0.0.1:8125/post-echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' }).then(r => r.status).catch(e => 'ERR:' + e.message);
  R.put = await fetch('/post-echo', { method: 'PUT', body: 'put-body' }).then(r => r.status).catch(e => 'ERR:' + e.message);
  R.del = await fetch('/json', { method: 'DELETE' }).then(r => r.status).catch(e => 'ERR:' + e.message);
  R.head = await fetch('/json', { method: 'HEAD' }).then(r => r.status).catch(e => 'ERR:' + e.message);
  return R;
}`);
P('preflight/put/delete/head eval', R);
await sleep(600);
const list = await netList(pageId);
const tail = list.requests.slice(-8);
P('tail entries', tail.map(r => ({ reqid: r.reqid, url: r.url.slice(-45), method: r.method, type: r.type, status: r.status, error: r.error })));
// pagination beyond range
const far = await netList(pageId, { pageSize: 10, pageIdx: 999 });
P('pageIdx 999', { total: far.total, n: far.requests.length });
// negative/zero pageSize edge
const zero = await netList(pageId, { pageSize: 0 });
P('pageSize 0', { total: zero.total, n: zero.requests.length });
