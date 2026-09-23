// adv-09 main: full network-capture fidelity suite.
// Prints tagged results; survives bridge restarts via retrying call().
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (name, obj) => log(`\n=== ${name} ===\n` + (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(OUT, `adv09 run ${new Date().toISOString()}\n`);
await init();

// ---- open fresh page on my server ----
const pg = slim(await call('new_page', { url: 'http://localhost:8125/' }));
const pageId = pg.pageId;
P('new_page', pg);
await sleep(1500);

// attach debugger + reload so document/subresources are captured
await netList(pageId);
await evalJs(pageId, `() => { location.href = 'http://localhost:8125/?r=' + Date.now(); return 1; }`);
await sleep(3500);
const afterLoad = await netList(pageId);
P('after page load (doc/css/script/img/data:)', afterLoad);

// ---- coverage batch A: basic request types ----
const A = await evalJs(pageId, `async () => {
  const R = {};
  R.fetchGet = await fetch('/json').then(r => r.status).catch(e => 'ERR:' + e.message);
  R.xhr = await new Promise(res => { const x = new XMLHttpRequest(); x.onload = () => res(x.status); x.onerror = () => res('XERR'); x.ontimeout=()=>res('XTIMEOUT'); x.open('GET', '/json'); x.send(); });
  R.font = await new FontFace('adv9', 'url(/font.woff)').load().then(() => 'font-ok').catch(e => 'FERR:' + e.message);
  R.postJson = await fetch('/post-echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1, s: 'héllo-页面' }) }).then(r => r.status).catch(e => 'ERR:' + e.message);
  const fd = new FormData(); fd.append('field', 'väl'); fd.append('file', new Blob(['filebody123'], { type: 'text/plain' }), 'note.txt');
  R.formData = await fetch('/post-echo', { method: 'POST', body: fd }).then(r => r.status).catch(e => 'ERR:' + e.message);
  R.downloadFetch = await fetch('/download.bin').then(r => r.status).catch(e => 'ERR:' + e.message);
  R.dataUrl = await fetch('data:text/plain;base64,aGVsbG8tZGF0YQ==').then(async r => r.status + ':' + (await r.text())).catch(e => 'ERR:' + e.message);
  const burl = URL.createObjectURL(new Blob(['blobbody-xyz'], { type: 'text/plain' }));
  R.blobUrl = await fetch(burl).then(async r => r.status + ':' + (await r.text())).catch(e => 'ERR:' + e.message);
  R.r204 = await fetch('/204').then(r => r.status).catch(e => 'ERR:' + e.message);
  R.corsFail = await fetch('http://127.0.0.1:8125/nocors').then(r => 'unexpected:' + r.status).catch(e => 'ERR:' + e.message);
  const ac = new AbortController(); const p = fetch('/slow?ms=6000', { signal: ac.signal }); setTimeout(() => ac.abort(), 300);
  R.aborted = await p.then(() => 'NOT-ABORTED').catch(e => e.name);
  R.h2ext = await fetch('https://cdn.jsdelivr.net/npm/lodash@4/package.json').then(r => r.status).catch(e => 'ERR:' + e.message);
  return R;
}`);
P('batch A results (fetch/xhr/font/post/formdata/download/data/blob/204/cors/abort/h2)', A);
await sleep(800);
P('list after batch A', await netList(pageId));
