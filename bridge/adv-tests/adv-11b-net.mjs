// adv-11b-net.mjs — follow-up: fire-and-forget traffic + polling to classify
// late-arriving vs never-captured entries. Also tests POST postData, redirect
// chain fidelity, big-body get_network_request, WS visibility, data:/blob:.
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
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 200000);

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-11b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const call = async (n, a) => {
  const r = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a || {} } });
  const res = r.msg && r.msg.result;
  if (!res) return { err: 'NO-RESULT ' + r.status };
  if (res.isError) return { err: (res.content && res.content[0] && res.content[0].text) || 'isError' };
  if (res.structuredContent !== undefined) return { data: res.structuredContent };
  const t = (res.content && res.content[0] && res.content[0].text) || '';
  try { return { data: JSON.parse(t.replace(/^saved:[^\n]*\n/, '')) }; } catch { return { data: t }; }
};

let pageId;
const ev = fn => call('evaluate_script', { pageId, function: fn });
const net = async () => { const r = await call('list_network_requests', { pageId }); return r.err ? { err: r.err, requests: [] } : r.data; };
const dump = (l, reqs) => { for (const q of reqs) log(l + ' reqid=' + q.reqid + ' type=' + q.type + ' ' + q.method + ' ' + q.url.slice(0, 75) + ' status=' + q.status + ' err=' + (q.error || '-') + ' size=' + q.encodedSize + ' rid=' + q.requestId); };
// poll until predicate or timeout; returns last list
const pollNet = async (pred, ms) => {
  const t0 = Date.now(); let l = await net();
  while (Date.now() - t0 < ms) { if (pred(l.requests)) return { l, waited: Date.now() - t0 }; await sleep(400); l = await net(); }
  return { l, waited: Date.now() - t0, timeout: true };
};

try {
  const np = await call('new_page', { url: 'about:blank' });
  pageId = np.data.pageId;
  log('SETUP pageId=' + pageId);
  await net(); // attach + Network.enable
  await call('list_console_messages', { pageId }); // Runtime+Log enable
  await call('navigate_page', { pageId, type: 'url', url: 'https://example.com' });
  await sleep(1200);

  // ---- A: fire-and-forget basic traffic (fetch/img/xhr/data/blob/post) ----
  await ev(`() => {
    fetch('https://example.com/?ff=1').catch(() => {});
    fetch('data:text/plain,hello-data').then(r => r.text()).catch(() => {});
    const bu = URL.createObjectURL(new Blob(['blob-content-123'], { type: 'text/plain' }));
    fetch(bu).then(r => r.text()).catch(() => {});
    const im = new Image(); im.src = 'https://example.com/?img=2';
    const x = new XMLHttpRequest(); x.open('GET', 'https://example.com/?xhr=2'); x.send();
    fetch('https://example.com/?post=1', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'PAYLOAD-XYZ' }).catch(() => {});
    return 'fired';
  }`);
  const { l: n1, waited } = await pollNet(rs => rs.filter(q => /ff=1|img=2|xhr=2|post=1/.test(q.url)).every(q => q.status !== undefined) && rs.length >= 5, 8000);
  log('A waited=' + waited + ' total=' + n1.total);
  dump('A ', n1.requests);
  for (const tag of ['data:', 'blob:']) {
    const e = n1.requests.find(q => q.url.startsWith(tag));
    log('A ' + tag + ' entry=' + JSON.stringify(e || null));
  }
  // detail incl. POST body
  for (const q of n1.requests.filter(q => /post=1|blob:|data:|ff=1/.test(q.url))) {
    const r = await call('get_network_request', { pageId, reqid: q.reqid });
    const d = r.data || {};
    log('A detail reqid=' + q.reqid + ' url=' + q.url.slice(0, 40) + ' err=' + (r.err || '-') + ' status=' + d.status + ' postData=' + JSON.stringify(d.postData) + ' bodyLen=' + (d.responseBody ? d.responseBody.length : -1) + ' body=' + JSON.stringify(d.responseBody && d.responseBody.slice(0, 50)));
  }

  // ---- B: WebSocket — poll while socket tries to connect ----
  await ev(`() => { try { window.__ws = new WebSocket('wss://ws.postman-echo.com/raw'); } catch (e) {} try { window.__ws2 = new WebSocket('wss://echo.websocket.org'); } catch (e) {} return 'ws-fired'; }`);
  await sleep(3000);
  const n2 = await net();
  const wsE = n2.requests.filter(q => /wss?:\/\//i.test(q.url) || /websocket/i.test(q.type));
  log('B ws-entries=' + JSON.stringify(wsE) + ' total=' + n2.total);
  const cB = await call('list_console_messages', { pageId });
  log('B console ws-related=' + JSON.stringify((cB.data ? cB.data.messages : []).filter(m => /websocket|ws\.postman|echo/i.test(String(m.text))).map(m => m.type + ':' + String(m.text).slice(0, 90))));

  // ---- C: failures — poll for error field ----
  await ev(`() => {
    fetch('https://nonexistent.invalid/?nx=2', { mode: 'no-cors' }).catch(() => {});
    fetch('https://example.com:1/?port=2', { mode: 'no-cors' }).catch(() => {});
    fetch('https://example.com:4444/?refused=2', { mode: 'no-cors' }).catch(() => {});
    return 'fired';
  }`);
  const { l: n3 } = await pollNet(rs => {
    const e = rs.filter(q => /nx=2|port=2|refused=2/.test(q.url));
    return e.length === 3 && e.every(q => q.error !== undefined || q.status !== undefined);
  }, 9000);
  dump('C ', n3.requests.filter(q => /nx=2|port=2|refused=2/.test(q.url)));
  // detail of a failed request
  const fx = n3.requests.find(q => q.url.includes('nx=2'));
  if (fx) { const r = await call('get_network_request', { pageId, reqid: fx.reqid }); log('C detail nx err=' + (r.err || '-') + ' error=' + JSON.stringify(r.data && r.data.error) + ' status=' + (r.data && r.data.status) + ' body=' + JSON.stringify(r.data && r.data.responseBody)); }

  // ---- D: redirect chain (https->https, no mixed content) ----
  await ev(`() => { fetch('https://httpbin.org/redirect/2?d=1').then(r => r.text()).catch(() => {}); fetch('https://httpstat.us/301').catch(() => {}); return 'fired'; }`);
  const { l: n4 } = await pollNet(rs => rs.filter(q => /httpbin|httpstat/.test(q.url)).some(q => q.status === 200), 10000);
  dump('D ', n4.requests.filter(q => /httpbin|httpstat/.test(q.url)));
  // detail on first chain element (the 302) — whose body does it return?
  const chain = n4.requests.filter(q => q.url.includes('httpbin'));
  for (const q of chain) {
    const r = await call('get_network_request', { pageId, reqid: q.reqid });
    const d = r.data || {};
    log('D detail reqid=' + q.reqid + ' url=' + q.url.slice(0, 55) + ' status=' + d.status + ' bodyLen=' + (d.responseBody ? d.responseBody.length : -1) + ' err=' + (r.err || '-'));
  }

  // ---- E: big body — fire + poll for encodedSize, then time the detail call ----
  await ev(`() => { fetch('https://speed.hetzner.de/5MB.bin?e=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).then(r => r.blob()).catch(() => {}); fetch('https://proof.ovh.net/files/5Mb.dat?e=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).then(r => r.blob()).catch(() => {}); return 'fired'; }`);
  const { l: n5, timeout } = await pollNet(rs => rs.some(q => /5MB\.bin|5Mb\.dat/.test(q.url) && q.encodedSize > 1000000), 30000);
  const be = n5.requests.filter(q => /5MB\.bin|5Mb\.dat/.test(q.url));
  dump('E ', be);
  if (be.length) {
    const done = be.find(q => q.encodedSize > 1000000) || be[0];
    const t0 = Date.now();
    const r = await call('get_network_request', { pageId, reqid: done.reqid });
    const ms = Date.now() - t0;
    log('E detail reqid=' + done.reqid + ' took=' + ms + 'ms err=' + (r.err || '-') + ' status=' + (r.data && r.data.status) + ' bodyLen=' + (r.data && r.data.responseBody ? r.data.responseBody.length : -1) + ' truncated?=' + (r.data && r.data.responseBody ? r.data.responseBody.length < 4000000 : 'n/a'));
    if (timeout) log('E note: download poll timed out; entry may still be in-flight');
  } else log('E no big-file entries captured (fetch failed?)');

  // ---- F: cache behavior — same URL twice, does 2nd (cached) get a body? ----
  await ev(`() => { fetch('https://example.com/?cache=1').catch(() => {}); return 'fired'; }`);
  await pollNet(rs => rs.some(q => q.url.includes('cache=1') && q.status !== undefined), 6000);
  await ev(`() => { fetch('https://example.com/?cache=1').catch(() => {}); return 'fired2'; }`);
  const { l: n6 } = await pollNet(rs => rs.filter(q => q.url.includes('cache=1')).length >= 2, 6000);
  const ce = n6.requests.filter(q => q.url.includes('cache=1'));
  dump('F ', ce);
  for (const q of ce) {
    const r = await call('get_network_request', { pageId, reqid: q.reqid });
    log('F detail reqid=' + q.reqid + ' status=' + (r.data && r.data.status) + ' bodyLen=' + (r.data && r.data.responseBody ? r.data.responseBody.length : -1) + ' err=' + (r.err || '-'));
  }

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
