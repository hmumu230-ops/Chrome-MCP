// adv-11c-net.mjs — isolated tests on a LOCAL http+ws server (no proxy/MITM):
// burst same-origin reqs (do statuses land?), real 5MB body fetch + timed
// get_network_request, clean 301 chain fidelity, 404 capture, resourceTypes
// filter, pagination, and a WORKING ws:// echo to prove WS is invisible.
import http from 'node:http';
import { WebSocketServer } from 'ws';

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

const BIG = Buffer.alloc(5 * 1024 * 1024, 'A');
const server = http.createServer((req, res) => {
  const u = req.url;
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>local test</body></html>'); }
  else if (u === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length }); res.end(BIG); }
  else if (u === '/redir') { res.writeHead(301, { location: '/target' }).end(); }
  else if (u === '/target') { res.writeHead(200, { 'content-type': 'text/plain' }).end('REDIR-TARGET-BODY'); }
  else if (u === '/status404') { res.writeHead(404).end('nope'); }
  else if (u.startsWith('/burst')) { res.writeHead(200, { 'content-type': 'text/plain' }).end('B-' + u); }
  else if (u === '/slow') { setTimeout(() => res.end('slow'), 15000); } // never finishes within test window
  else { res.writeHead(200).end('ok'); }
});
const wss = new WebSocketServer({ port: 8125 });
wss.on('connection', ws => ws.on('message', m => ws.send('echo:' + m)));
await new Promise(r => server.listen(8124, '127.0.0.1', r));

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-11c', version: '0' } } });
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
const net = async (x) => { const r = await call('list_network_requests', { pageId, ...(x || {}) }); return r.err ? { err: r.err, requests: [] } : r.data; };
const dump = (l, reqs) => { for (const q of reqs) log(l + ' reqid=' + q.reqid + ' type=' + q.type + ' ' + q.method + ' ' + q.url.slice(0, 70) + ' status=' + q.status + ' err=' + (q.error || '-') + ' size=' + q.encodedSize + ' rid=' + q.requestId); };
const pollNet = async (pred, ms) => {
  const t0 = Date.now(); let l = await net();
  while (Date.now() - t0 < ms) { if (pred(l.requests)) return { l, waited: Date.now() - t0 }; await sleep(300); l = await net(); }
  return { l, waited: Date.now() - t0, timeout: true };
};

try {
  const np = await call('new_page', { url: 'about:blank' });
  pageId = np.data.pageId;
  log('SETUP pageId=' + pageId);
  await net();
  await call('list_console_messages', { pageId });
  await call('navigate_page', { pageId, type: 'url', url: 'http://127.0.0.1:8124/' });
  await sleep(1200);
  dump('NAV ', (await net()).requests);

  // ---- G: burst of same-origin requests on clean local net ----
  await ev(`() => {
    fetch('/burst1'); fetch('/burst2'); fetch('/burst3');
    new Image().src = '/burst4';
    const x = new XMLHttpRequest(); x.open('GET', '/burst5'); x.send();
    return 'fired';
  }`);
  const { l: g, waited: gw } = await pollNet(rs => rs.filter(q => /burst/.test(q.url)).length === 5 && rs.filter(q => /burst/.test(q.url)).every(q => q.status === 200), 8000);
  log('G waited=' + gw);
  dump('G ', g.requests.filter(q => /burst/.test(q.url)));

  // ---- H: real 5MB body ----
  await ev(`() => { fetch('/big').then(r => r.arrayBuffer()).catch(() => {}); return 'fired'; }`);
  const { l: h, timeout: hto } = await pollNet(rs => rs.some(q => q.url.endsWith('/big') && q.encodedSize >= 5 * 1024 * 1024), 25000);
  const be = h.requests.find(q => q.url.endsWith('/big'));
  log('H big-entry=' + JSON.stringify(be) + ' pollTimeout=' + !!hto);
  if (be) {
    const t0 = Date.now();
    const r = await call('get_network_request', { pageId, reqid: be.reqid });
    const ms = Date.now() - t0;
    const bl = r.data && r.data.responseBody ? r.data.responseBody.length : -1;
    log('H detail took=' + ms + 'ms err=' + (r.err || '-') + ' status=' + (r.data && r.data.status) + ' bodyLen=' + bl + ' expected=' + BIG.length + ' allA=' + (r.data && r.data.responseBody ? /^A+$/.test(r.data.responseBody) : '-'));
  }

  // ---- I: clean redirect chain (same-origin 301) ----
  await ev(`() => { fetch('/redir').catch(() => {}); return 'fired'; }`);
  const { l: iv } = await pollNet(rs => rs.some(q => q.url.endsWith('/target') && q.status === 200), 8000);
  const chain = iv.requests.filter(q => /\/redir|\/target/.test(q.url));
  dump('I ', chain);
  for (const q of chain) {
    const r = await call('get_network_request', { pageId, reqid: q.reqid });
    log('I detail reqid=' + q.reqid + ' url=' + q.url.slice(-12) + ' status=' + (r.data && r.data.status) + ' body=' + JSON.stringify(r.data && r.data.responseBody) + ' err=' + (r.err || '-'));
  }

  // ---- J: 404 + in-flight request ----
  await ev(`() => { fetch('/status404').catch(() => {}); fetch('/slow').catch(() => {}); return 'fired'; }`);
  const { l: j } = await pollNet(rs => rs.some(q => q.url.endsWith('/status404') && q.status === 404), 8000);
  dump('J ', j.requests.filter(q => /status404|\/slow/.test(q.url)));
  const sl = j.requests.find(q => q.url.endsWith('/slow'));
  if (sl) { const r = await call('get_network_request', { pageId, reqid: sl.reqid }); log('J inflight-detail status=' + (r.data && r.data.status) + ' body=' + JSON.stringify(r.data && r.data.responseBody) + ' err=' + (r.err || '-')); }

  // ---- K: resourceTypes filter + pagination ----
  const imgOnly = await net({ resourceTypes: ['Image'] });
  log('K resourceTypes=[Image] total=' + imgOnly.total + ' -> ' + imgOnly.requests.map(q => q.url.slice(-10)).join(' | '));
  const pg = await net({ pageSize: 2, pageIdx: 0 });
  log('K pageSize=2 pageIdx=0 -> items=' + pg.requests.length + ' total=' + pg.total + ' first=' + (pg.requests[0] && pg.requests[0].url.slice(-15)));
  const pg2 = await net({ pageSize: 2, pageIdx: 1 });
  log('K pageIdx=1 -> items=' + pg2.requests.length + ' first=' + (pg2.requests[0] && pg2.requests[0].url.slice(-15)));

  // ---- L: WORKING ws:// echo — still invisible to Network collector? ----
  await ev(`() => {
    const w = new WebSocket('ws://127.0.0.1:8125');
    w.onopen = () => w.send('hello-ws');
    w.onmessage = e => console.log('WS-RECV:' + e.data);
    w.onerror = () => console.log('WS-ERR');
    return 'ws-fired';
  }`);
  await sleep(2000);
  const lw = await net();
  const wsE = lw.requests.filter(q => /ws:\/\/|8125|websocket/i.test(q.url + q.type));
  const cw = await call('list_console_messages', { pageId });
  log('L ws-entries=' + JSON.stringify(wsE));
  log('L ws-console=' + JSON.stringify((cw.data ? cw.data.messages : []).map(m => m.type + ':' + String(m.text).slice(0, 60))));

} catch (e) {
  log('FATAL ' + (e && e.stack || e));
} finally {
  if (pageId) {
    const a = await call('detach_debugger', { pageId });
    const b = await call('close_page', { pageId });
    log('CLEANUP detach=' + JSON.stringify(a.data || a.err) + ' close=' + JSON.stringify(b.data || b.err));
  }
  server.close(); wss.close();
}
log('DONE');
process.exit(0);
