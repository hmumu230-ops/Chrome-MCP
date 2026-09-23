// Phase 2: redirects (per-hop status), SSE, WebSocket
import { init, call, slim, evalJs, netList, netGet } from './adv-09.mjs';
import fs from 'node:fs';
const OUT = new URL('./adv-09-results.txt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(OUT, s + '\n'); };
const P = (n, o) => log(`\n=== ${n} ===\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pageId = Number(process.argv[2]);
await init();

// fire all redirect chains + SSE + WS in one eval
const R = await evalJs(pageId, `async () => {
  const R = {};
  for (const code of [301, 302, 307, 308]) {
    R['r' + code] = await fetch('/r' + code + '/3').then(r => r.status + ':' + r.url.split('/').pop()).catch(e => 'ERR:' + e.message);
  }
  R.mixed = await fetch('/chain-mixed').then(r => r.status).catch(e => 'ERR:' + e.message);
  R.xorigin = await fetch('/xorigin').then(r => r.status + '->' + new URL(r.url).host).catch(e => 'ERR:' + e.message);
  R.sse = await new Promise(res => { const es = new EventSource('/sse'); let n = 0; es.onmessage = () => { if (++n >= 2) { es.close(); res('got-2-ticks'); } }; es.onerror = () => { es.close(); res('SSE-ERR'); }; setTimeout(() => { es.close(); res('sse-timeout n=' + n); }, 8000); });
  R.ws = await new Promise(res => { const w = new WebSocket('ws://localhost:8125/ws-echo'); const got = []; w.onmessage = e => { got.push(e.data); if (got.length >= 2) { w.close(); res(got.join('|')); } }; w.onopen = () => w.send('ping-1'); w.onerror = () => res('WS-ERR'); setTimeout(() => res('ws-timeout got=' + got.join('|')), 8000); });
  return R;
}`);
P('redirect/sse/ws eval results', R);
await sleep(800);
P('list after redirects+sse+ws', await netList(pageId));
