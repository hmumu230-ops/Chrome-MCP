// Phase 4: SW, cache 200-hit/304, big body, in-flight, timing
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
  // service worker
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await new Promise(res => { const t = setInterval(() => { if (navigator.serviceWorker.controller) { clearInterval(t); res(1); } }, 150); setTimeout(() => { clearInterval(t); res(0); }, 6000); });
    if (!navigator.serviceWorker.controller) { location.reload(); await new Promise(()=>{}); }
    R.swRegistered = !!navigator.serviceWorker.controller;
    R.swServed = await fetch('/sw-served').then(r => r.text());
    R.swCached = await fetch('/sw-cached').then(r => r.text());
    R.swCached2 = await fetch('/sw-cached').then(r => r.text()); // 2nd hit served from SW cache
  } catch (e) { R.swErr = String(e); }
  // cache: prime then re-hit (memory/disk cache -> 200 from cache), then revalidate -> 304
  R.cacheA = await fetch('/cache', { cache: 'default' }).then(r => r.status);
  R.cacheB = await fetch('/cache', { cache: 'default' }).then(r => r.status); // likely memory-cache hit
  R.cache304 = await fetch('/cache', { cache: 'no-cache' }).then(r => r.status); // revalidate -> 304
  // big body 1.5MB
  R.big = await fetch('/big?n=1500000').then(async r => r.status + ':' + (await r.text()).length).catch(e => 'ERR:' + e.message);
  return R;
}`);
P('sw/cache/big results', R);

// in-flight test: start /hang, list while in-flight
await evalJs(pageId, `() => { window.__hangP = fetch('/hang').then(r=>'done').catch(e=>'ERR:'+e.message); return 'started'; }`);
await sleep(600);
const inflightList = await netList(pageId);
const inflight = inflightList.requests.filter(r => r.url.includes('/hang'));
P('in-flight /hang entry in list', inflight);
if (inflight[0]) {
  const d = await netGet(pageId, inflight[0].reqid);
  P('get_network_request on in-flight', { ...d, responseBody: d && d.responseBody ? d.responseBody.slice(0,80) : d && d.responseBody });
}

// timing check: /slow?ms=2000
await evalJs(pageId, `async () => { const t0 = performance.now(); const s = await fetch('/slow?ms=2000').then(r => r.status); window.__slowMs = performance.now() - t0; return { status: s, ms: window.__slowMs }; }`);
const list2 = await netList(pageId);
P('tail of list (slow + sw + cache + big)', list2.requests.slice(-12));
for (const r of list2.requests.slice(-12)) {
  if (r.url.includes('/slow') || r.url.includes('/sw-') || r.url.includes('/cache') || r.url.includes('/big')) {
    try {
      const d = await netGet(pageId, r.reqid);
      P('detail reqid ' + r.reqid + ' ' + r.url, { status: d.status, error: d.error, mimeType: d.mimeType, encodedSize: d.encodedSize, bodyLen: d.responseBody ? d.responseBody.length : undefined, bodyHead: d.responseBody ? d.responseBody.slice(0, 60) : undefined });
    } catch (e) { P('detail reqid ' + r.reqid + ' THREW ' + e.message); }
  }
}
