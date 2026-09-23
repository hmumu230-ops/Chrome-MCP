// Phase 7: file output outside repo (binary fidelity), error surfacing, postData variants
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageId = Number(process.argv[2]);
await init();

// fire fresh requests: png (binary), json post, download.bin
await evalJs(pageId, `async () => {
  await fetch('/img.png');
  await fetch('/download.bin');
  await fetch('/post-echo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=h%C3%A9llo' });
  return 'done';
}`);
await sleep(700);
const list = await netList(pageId);
const byUrl = {};
for (const r of list.requests) byUrl[r.url] = r.reqid;
log('reqids:', JSON.stringify(byUrl));

// binary file write outside repo
const fImg = await call('get_network_request', { pageId, reqid: byUrl['http://localhost:8125/img.png'], responseFilePath: 'D:\\adv09-out\\img.png' });
log('img file write result text:', (fImg.content || []).map(c => c.text).join(' | ').slice(0, 300));
const fBin = await call('get_network_request', { pageId, reqid: byUrl['http://localhost:8125/download.bin'], responseFilePath: 'D:\\adv09-out\\blob.bin' });
log('bin file write result text:', (fBin.content || []).map(c => c.text).join(' | ').slice(0, 300));
const fPost = await call('get_network_request', { pageId, reqid: byUrl['http://localhost:8125/post-echo'], requestFilePath: 'D:\\adv09-out\\post.txt' });
log('post reqfile result text:', (fPost.content || []).map(c => c.text).join(' | ').slice(0, 300));

// verify on disk
for (const f of ['D:\\adv09-out\\img.png', 'D:\\adv09-out\\blob.bin', 'D:\\adv09-out\\post.txt']) {
  if (fs.existsSync(f)) {
    const b = fs.readFileSync(f);
    log(`file ${f}: ${b.length} bytes, head=${b.subarray(0, 16).toString('hex')}`);
  } else log(`file ${f}: MISSING`);
}
// expected PNG head: 89 50 4E 47 0D 0A 1A 0A
// expected post.txt content: a=1&b=h%C3%A9llo
