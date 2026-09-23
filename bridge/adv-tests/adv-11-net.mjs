// adv-11-net.mjs — network/console capture robustness tests for chrome-mcp.
// Covers: doc capture, reqid sequence, detail(headers+body), fetch/XHR/img/
// data:/blob: capture, WebSocket visibility, failed reqs, redirects, big
// bodies, console types/serialization/exceptions/flood, detach/re-attach,
// invalid ids. Cleans up: detach + close tab.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(a.join(' '));

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 220000);

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-11-net', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const call = async (n, a) => {
  const r = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const res = r.msg && r.msg.result;
  if (!res) return { err: 'NO-RESULT status=' + r.status + ' ' + JSON.stringify(r.msg).slice(0, 300) };
  if (res.isError) return { err: (res.content && res.content[0] && res.content[0].text) || 'isError' };
  if (res.structuredContent !== undefined) return { data: res.structuredContent };
  const t = (res.content && res.content[0] && res.content[0].text) || '';
  try { return { data: JSON.parse(t.replace(/^saved:[^\n]*\n/, '')) }; } catch { return { data: t }; }
};

let pageId;
const ev = async (fn) => {
  const r = await call('evaluate_script', { pageId, function: fn });
  return r.err ? 'EVAL-ERR: ' + r.err : (r.data && r.data.result);
};
const net = async () => {
  const r = await call('list_network_requests', { pageId });
  return r.err ? { err: r.err, requests: [] } : r.data;
};
const con = async (extra) => {
  const r = await call('list_console_messages', { pageId, ...(extra || {}) });
  return r.err ? { err: r.err, messages: [] } : r.data;
};
const brief = q => `reqid=${q.reqid} type=${q.type} ${q.method} ${q.url.slice(0, 80)} status=${q.status} err=${q.error || '-'} size=${q.encodedSize}`;

try {
  // ---------- setup ----------
  const np = await call('new_page', { url: 'about:blank' });
  pageId = np.data.pageId;
  log('SETUP pageId=' + pageId);

  // FIRST call: attach debugger + enable Network before any traffic
  let r = await net();
  log('S1 initial-net err=' + r.err + ' total=' + r.total);
  r = await con();
  log('S1b initial-console err=' + r.err + ' total=' + r.total); // enables Runtime+Log early

  // ---------- navigation capture ----------
  r = await call('navigate_page', { pageId, type: 'url', url: 'https://example.com' });
  log('S2 nav err=' + r.err + ' url=' + (r.data && r.data.url));
  await sleep(1500);
  const n1 = await net();
  log('S3 after-nav total=' + n1.total + ' err=' + (n1.err || '-'));
  for (const q of n1.requests) log('   ' + brief(q));
  const ids = n1.requests.map(x => x.reqid);
  const seq = ids.every((v, k) => k === 0 || v === ids[k - 1] + 1);
  log('S3 reqids=' + ids.join(',') + ' sequential=' + seq);
  const doc = n1.requests.find(q => q.type === 'Document') || n1.requests[0];

  const d0 = Date.now();
  r = await call('get_network_request', { pageId, reqid: doc.reqid });
  const d = r.data;
  log('S4 detail(' + (Date.now() - d0) + 'ms) err=' + r.err
    + ' reqHdrs=' + !!(d && d.requestHeaders && Object.keys(d.requestHeaders).length)
    + ' respHdrs=' + !!(d && d.responseHeaders && Object.keys(d.responseHeaders).length)
    + ' status=' + (d && d.status)
    + ' postData=' + JSON.stringify(d && d.postData)
    + ' bodyLen=' + (d && d.responseBody ? d.responseBody.length : -1)
    + ' bodyOk=' + (d && d.responseBody ? d.responseBody.includes('Example Domain') : false));

  // ---------- generated traffic ----------
  r = await ev(`async () => {
    const R = {};
    try { const x = await fetch('https://example.com/?fetch=1'); R.fetch = x.status; } catch (e) { R.fetch = 'ERR:' + e.message; }
    try { const x = await fetch('data:text/plain,hello-data-url'); R.data = await x.text(); } catch (e) { R.data = 'ERR:' + e.message; }
    try { const u = URL.createObjectURL(new Blob(['hello-blob-content'], { type: 'text/plain' })); const x = await fetch(u); R.blob = (await x.text()); R.blobUrl = u; } catch (e) { R.blob = 'ERR:' + e.message; }
    R.img = await new Promise(res => { const im = new Image(); im.onload = () => res('load'); im.onerror = () => res('error'); im.src = 'https://example.com/?img=1'; });
    R.xhr = await new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', 'https://example.com/?xhr=1'); x.onloadend = () => res('end:' + x.status); x.onerror = () => res('err'); x.send(); });
    return R;
  }`);
  log('S5 gen-traffic=' + JSON.stringify(r));
  await sleep(1200);
  const n2 = await net();
  log('S5 total=' + n2.total);
  for (const q of n2.requests) log('   ' + brief(q));
  const find = s => n2.requests.filter(q => q.url.includes(s)).map(q => ({ reqid: q.reqid, type: q.type, status: q.status, error: q.error }));
  log('S5 fetch=' + JSON.stringify(find('?fetch=1')));
  log('S5 data =' + JSON.stringify(find('data:text')));
  log('S5 blob =' + JSON.stringify(find('blob:')));
  log('S5 img  =' + JSON.stringify(find('?img=1')));
  log('S5 xhr  =' + JSON.stringify(find('?xhr=1')));
  // detail of blob/data entries — body retrieval on non-http schemes
  for (const q of n2.requests.filter(q => q.url.startsWith('data:') || q.url.startsWith('blob:'))) {
    const rr = await call('get_network_request', { pageId, reqid: q.reqid });
    log('S5b detail reqid=' + q.reqid + ' scheme=' + q.url.slice(0, 5) + ' err=' + rr.err + ' status=' + (rr.data && rr.data.status) + ' body=' + JSON.stringify(rr.data && rr.data.responseBody).slice(0, 80));
  }

  // ---------- WebSocket ----------
  r = await ev(`async () => {
    const tryWs = u => new Promise(res => {
      try {
        const w = new WebSocket(u);
        w.onopen = () => { try { w.send('ping-' + u); } catch {} res('open'); };
        w.onerror = () => res('error');
        w.onclose = e => res('close:' + e.code);
        setTimeout(() => res('timeout'), 2500);
      } catch (e) { res('threw:' + e.message); }
    });
    return { echo: await tryWs('wss://echo.websocket.org'), postman: await tryWs('wss://ws.postman-echo.com/raw') };
  }`);
  log('S6 ws-result=' + JSON.stringify(r));
  await sleep(800);
  const n3 = await net();
  const wsE = n3.requests.filter(q => /wss?:\/\//i.test(q.url) || /websocket/i.test(q.type));
  log('S6 ws-entries=' + JSON.stringify(wsE) + ' (total=' + n3.total + ')');

  // ---------- failed requests ----------
  r = await ev(`async () => {
    const t = async u => { try { await fetch(u, { mode: 'no-cors' }); return 'ok'; } catch (e) { return 'ERR:' + e.message; } };
    return { nx: await t('https://nonexistent.invalid/?nx=1'), port: await t('https://example.com:1/?port=1') };
  }`);
  log('S7 fail-fetch=' + JSON.stringify(r));
  await sleep(1200);
  const n4 = await net();
  log('S7 nx  =' + JSON.stringify(n4.requests.filter(q => q.url.includes('nonexistent.invalid')).map(q => ({ reqid: q.reqid, status: q.status, error: q.error }))));
  log('S7 port=' + JSON.stringify(n4.requests.filter(q => q.url.includes(':1/')).map(q => ({ reqid: q.reqid, status: q.status, error: q.error }))));

  // ---------- redirects ----------
  r = await ev(`async () => {
    const t = async (u, m) => { try { const x = await fetch(u, { mode: m || 'cors', redirect: 'follow' }); return 'ok:' + x.status + ':' + x.type; } catch (e) { return 'ERR:' + e.message; } };
    return { gh: await t('http://github.com/?redir=1', 'no-cors'), hb: await t('https://httpbin.org/redirect/2') };
  }`);
  log('S8 redir=' + JSON.stringify(r));
  await sleep(1500);
  const n5 = await net();
  log('S8 gh-chain :' + JSON.stringify(n5.requests.filter(q => q.url.includes('github.com')).map(q => ({ reqid: q.reqid, url: q.url.slice(0, 60), status: q.status, requestId: q.requestId }))));
  log('S8 hb-chain :' + JSON.stringify(n5.requests.filter(q => q.url.includes('httpbin')).map(q => ({ reqid: q.reqid, url: q.url.slice(0, 60), status: q.status, requestId: q.requestId }))));

  // ---------- huge response ----------
  r = await ev(`async () => {
    const urls = ['https://speed.hetzner.de/5MB.bin', 'https://proof.ovh.net/files/5Mb.dat'];
    for (const u of urls) {
      try { const x = await fetch(u + '?x=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }); await x.blob().catch(() => {}); return 'done:' + u; }
      catch (e) { }
    }
    return 'ALL-FAILED';
  }`);
  log('S9 big-fetch=' + JSON.stringify(r));
  await sleep(1000);
  const n6 = await net();
  const big = n6.requests.filter(q => /5MB\.bin|5Mb\.dat/.test(q.url));
  log('S9 big-entries=' + JSON.stringify(big.map(q => ({ reqid: q.reqid, status: q.status, size: q.encodedSize, error: q.error }))));
  if (big.length) {
    const t0 = Date.now();
    const rr = await call('get_network_request', { pageId, reqid: big[0].reqid });
    const ms = Date.now() - t0;
    log('S9 big-detail took=' + ms + 'ms err=' + (rr.err || '-')
      + ' status=' + (rr.data && rr.data.status)
      + ' bodyLen=' + (rr.data && rr.data.responseBody ? rr.data.responseBody.length : -1)
      + ' tail=' + JSON.stringify(rr.data && rr.data.responseBody && rr.data.responseBody.slice(-40)));
  }

  // ---------- console ----------
  r = await ev(`() => {
    console.log('LOG-msg', 'second-arg', 42);
    console.warn('WARN-msg');
    console.error('ERROR-msg');
    console.debug('DEBUG-msg');
    console.info('INFO-msg');
    console.log('OBJ-marker', { a: 1, b: [2, 3], c: { d: 'x' } });
    console.log('UNDEF-marker', undefined, null, 123n);
    console.error(new Error('ERR-OBJECT-msg'));
    console.count('CNT');
    setTimeout(() => { throw new Error('THROWN-msg'); }, 30);
    Promise.reject(new Error('REJECT-msg'));
    return 'emitted';
  }`);
  log('S10 emit=' + JSON.stringify(r));
  await sleep(1200);
  const c1 = await con();
  log('S10 console total=' + c1.total + ' err=' + (c1.err || '-'));
  for (const m of c1.messages) log('   msgid=' + m.msgid + ' type=' + m.type + ' url=' + (m.url || '-').slice(-40) + ' | ' + String(m.text).slice(0, 140).replace(/\n/g, '\\n'));
  const cErr = await con({ types: ['error'] });
  log('S10 types=[error] total=' + cErr.total + ' -> ' + cErr.messages.map(m => m.type + ':' + String(m.text).slice(0, 40)).join(' | '));
  const first = c1.messages[0];
  if (first) {
    const gm = await call('get_console_message', { pageId, msgid: first.msgid });
    log('S10 get msgid=' + first.msgid + ' err=' + gm.err + ' text=' + JSON.stringify(gm.data && gm.data.text).slice(0, 100));
  }

  // ---------- console flood ----------
  r = await ev(`() => { for (let k = 0; k < 100; k++) console.log('rapid-' + k); return 100; }`);
  await sleep(1200);
  const c2 = await con();
  const rapid = c2.messages.filter(m => /^rapid-\d+$/.test(m.text));
  const missing = [];
  for (let k = 0; k < 100; k++) if (!rapid.some(m => m.text === 'rapid-' + k)) missing.push(k);
  log('S11 rapid total=' + c2.total + ' rapid=' + rapid.length + ' missing=' + JSON.stringify(missing.slice(0, 10)) + (missing.length > 10 ? '...' : ''));

  // ---------- reload: loader filter + console clear ----------
  await ev(`() => { console.log('PRE-RELOAD-marker'); return 1; }`);
  await sleep(400);
  r = await call('navigate_page', { pageId, type: 'reload' });
  await sleep(2000);
  const n7 = await net();
  const c3 = await con();
  log('S12 post-reload net.total=' + n7.total + ' urls=' + n7.requests.map(q => q.url.slice(0, 50)).join(' | '));
  log('S12 post-reload console.total=' + c3.total + ' hasPreReloadMarker=' + c3.messages.some(m => m.text.includes('PRE-RELOAD-marker')) + ' hasRapid=' + c3.messages.some(m => /^rapid-/.test(m.text)));

  // ---------- invalid ids ----------
  r = await call('get_network_request', { pageId, reqid: 999999 });
  log('S13 bad-reqid err=' + r.err);
  r = await call('get_console_message', { pageId, msgid: 999999 });
  log('S13 bad-msgid err=' + r.err);

  // ---------- detach / re-attach ----------
  r = await call('detach_debugger', { pageId });
  log('S14 detach=' + JSON.stringify(r.data || r.err));
  const n8 = await net();   // re-attaches fresh
  const c4 = await con();
  log('S14 post-detach net.total=' + n8.total + ' console.total=' + c4.total);
  r = await call('get_network_request', { pageId });
  log('S14 get-no-reqid-empty err=' + r.err);
  r = await ev(`async () => { try { await fetch('https://example.com/?postattach=1'); return 'ok'; } catch (e) { return 'ERR:' + e.message; } }`);
  await sleep(1000);
  const n9 = await net();
  const pa = n9.requests.filter(q => q.url.includes('postattach=1'));
  log('S14 reattach net.total=' + n9.total + ' postattach=' + JSON.stringify(pa.map(q => ({ reqid: q.reqid, status: q.status }))));

  // ---------- invalid reqid for old-loader request ----------
  // (skipped: loader list already validated above)

} catch (e) {
  log('FATAL ' + (e && e.stack || e));
} finally {
  if (pageId) {
    const a = await call('detach_debugger', { pageId });
    const b = await call('close_page', { pageId });
    log('CLEANUP detach=' + JSON.stringify(a.data || a.err) + ' close=' + JSON.stringify(b.data || b.err));
  }
}
log('DONE');
