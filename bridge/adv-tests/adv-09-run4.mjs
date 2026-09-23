// Phase 3: get_network_request detail fidelity
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

function show(reqid, d) {
  if (!d || typeof d !== 'object') return log(`\n--- reqid ${reqid} ---\n` + JSON.stringify(d));
  const o = { ...d };
  if (o.responseBody) o.responseBody = `[len=${o.responseBody.length}] ` + o.responseBody.slice(0, 220);
  if (o.responseHeaders) o.responseHeaders = Object.keys(o.responseHeaders).length + ' keys: ' + JSON.stringify(o.responseHeaders).slice(0, 400);
  if (o.requestHeaders) o.requestHeaders = Object.keys(o.requestHeaders).length + ' keys: ' + JSON.stringify(o.requestHeaders).slice(0, 400);
  log(`\n--- reqid ${reqid} ---\n` + JSON.stringify(o, null, 1));
}

for (const reqid of [6, 9, 10, 11, 4, 14, 18, 21, 15, 41]) {
  try { show(reqid, await netGet(pageId, reqid)); }
  catch (e) { log(`\n--- reqid ${reqid} THREW: ${e.message}`); }
}
