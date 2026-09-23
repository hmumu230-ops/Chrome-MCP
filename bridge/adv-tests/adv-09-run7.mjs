// Phase 6: file output detail, get-by-omitted-reqid, invalid reqid, real download, timing accuracy
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

// fresh request to have a current-loader reqid
await evalJs(pageId, `async () => (await fetch('/json')).status`);
const list = await netList(pageId);
const last = list.requests[list.requests.length - 1];
log('last reqid:', last.reqid, last.url);

// file output — full response (untruncated)
const fr = await call('get_network_request', { pageId, reqid: last.reqid, responseFilePath: 'adv-tests\\adv09-out\\body.json', requestFilePath: 'adv-tests\\adv09-out\\req.txt' });
P('get w/ file paths — full result', slim(fr));

// get with NO reqid → should return last request
const noId = await netGet(pageId, undefined);
P('get w/o reqid (last)', { reqid: noId.reqid, url: noId.url, status: noId.status });

// invalid reqid
const bad = await call('get_network_request', { pageId, reqid: 99999 });
P('get invalid reqid', slim(bad));

// real browser download via <a download> — does it appear in network list?
const before = (await netList(pageId)).total;
await evalJs(pageId, `() => { const a = document.createElement('a'); a.href = '/download.bin'; a.download = 'adv09.bin'; document.body.appendChild(a); a.click(); return 'clicked'; }`);
await sleep(2500);
const afterDl = await netList(pageId);
P('after <a download> click', { before, after: afterDl.total, newEntries: afterDl.requests.filter(r => r.url.includes('download')) });

// timing accuracy: fetch /slow?ms=1500, compare wallTime vs client-side duration
const t0 = Date.now();
await evalJs(pageId, `async () => (await fetch('/slow?ms=1500')).status`);
const listT = await netList(pageId);
const slow = listT.requests.filter(r => r.url.includes('/slow?ms=1500')).pop();
if (slow) {
  const wallMs = slow.wallTime * 1000;
  P('timing /slow?ms=1500', {
    wallStartIso: new Date(wallMs).toISOString(),
    callDoneIso: new Date().toISOString(),
    note: 'no end-time/duration fields exist — only start timestamp+wallTime',
    fields: Object.keys(slow),
  });
}
