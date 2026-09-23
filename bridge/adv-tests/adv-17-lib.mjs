// adv-17-lib.mjs — shared persistent-session MCP client for adversarial
// concurrency tests. One McpSession = one MCP session (initialize -> sid).
// Parallel call()s on a session issue parallel HTTP POSTs (StreamableHTTP).

const BASE = 'http://127.0.0.1:7890/mcp';
export const HEALTH = 'http://127.0.0.1:7890/';

export class McpSession {
  constructor(name = 's') {
    this.name = name;
    this.sid = null;
    this.nextId = 1;
    this.log = [];
  }

  // Low-level JSON-RPC POST. Returns { reqId, resId, status, msg, ms, error }.
  async rpc(method, params, { timeout = 60000 } = {}) {
    const reqId = this.nextId++;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(BASE, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
        signal: ctrl.signal,
      });
      const sidHdr0 = res.headers.get('mcp-session-id');
      if (sidHdr0) this.sid = sidHdr0;
      var text = await res.text();
      clearTimeout(t);
    } catch (e) {
      clearTimeout(t);
      return { reqId, resId: null, status: 0, msg: null, ms: Date.now() - t0, error: 'fetch:' + (e.name === 'AbortError' ? 'client-timeout' : e.message) };
    }
    const sidHdr = res.headers.get('mcp-session-id');
    if (sidHdr) this.sid = sidHdr;
    const dataLines = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    let msg = null;
    try { msg = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1]) : JSON.parse(text); }
    catch { msg = { raw: text.slice(0, 300) }; }
    return { reqId, resId: msg && msg.id !== undefined ? msg.id : null, status: res.status, msg, ms: Date.now() - t0 };
  }

  // JSON-RPC notification (no id, expect 202/empty).
  async notify(method, params) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    try {
      await fetch(BASE, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      });
    } catch {}
  }

  async init() {
    const r = await this.rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'adv17-' + this.name, version: '0' },
    });
    if (r.error || r.status !== 200 || !r.msg || r.msg.error || !r.msg.result)
      throw new Error('init failed: status=' + r.status + ' ' + JSON.stringify(r.msg || r.error).slice(0, 200));
    // required by spec before further calls
    await this.notify('notifications/initialized', {});
    return this.sid;
  }

  // tools/call. Returns { reqId, resId, ms, ok, text, sc(scructuredContent), error, status }.
  async call(name, args = {}, opts = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args }, opts);
    const res = r.msg && r.msg.result;
    const content = (res && res.content) || [];
    const text = content.map(c => c.text || '').join('\n');
    const isErr = !!(res && res.isError) || !!(r.msg && r.msg.error);
    return {
      reqId: r.reqId, resId: r.resId, ms: r.ms, status: r.status,
      ok: !isErr && !r.error, isErr, text, sc: res && res.structuredContent,
      rpcError: r.msg && r.msg.error, error: r.error,
      raw: r.msg,
    };
  }

  async close() {
    if (!this.sid) return { status: 0 };
    try {
      const r = await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': this.sid } });
      this.sid = null;
      return { status: r.status };
    } catch (e) { return { status: 0, error: e.message }; }
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const health = async () => {
  try { return await fetch(HEALTH).then(r => r.json()); }
  catch (e) { return { error: e.message }; }
};

// Session map caps at MAX_SESSIONS=50; under shared load slots free as other
// clients disconnect — retry init until one opens.
export const initWithRetry = async (s, ms = 60000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { await s.init(); return s; }
    catch (e) { last = e; if (!/503|too many/.test(String(e))) throw e; await sleep(1500); }
  }
  throw last;
};

// Other clients can churn the /ws slot (last-wins) — wait for a stable window.
export const waitForExtension = async (ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await health();
    if (h.extensionConnected) return true;
    await sleep(500);
  }
  return false;
};

// Extract text content + error flag from a call result for compact logging.
export const brief = c =>
  !c ? '<none>'
  : c.error ? `<${c.error}>`
  : (c.isErr ? 'ERR ' : 'ok  ') + (c.text || JSON.stringify(c.rpcError || '')).replace(/\s+/g, ' ').slice(0, 160);

// Pull the [uid] token of the first snapshot line matching a regex.
export const uidOf = (snapCall, re) => {
  const lines = (snapCall.sc && snapCall.sc.lines) || [];
  const line = lines.find(l => re.test(l));
  const m = line && line.match(/\[([^\]]+)\]/);
  return m && m[1];
};

// Tiny static server for scriptable test pages. about:blank is NOT scriptable
// by this extension (no matchAboutBlank), so tests need a real origin.
//   /p?swap=0|1  — buttons A/B at fixed coords; swap=1 puts B at A's spot.
//                  Inline script arms window.name click-ledger + __ca/__cb.
//   /mut         — DOM mutating itself via setInterval + a self-mutating
//                  srcdoc iframe (multi-frame snapshot tear probe).
import http from 'node:http';

const PAGE_P = `<!doctype html><title>adv17-p</title><body>
<h1>adv17-race</h1>
<div id="wrap" style="position:relative">
<button id="a" style="position:absolute;left:20px;top:20px;width:120px;height:40px">A</button>
<button id="b" style="position:absolute;left:20px;top:80px;width:120px;height:40px">B</button>
<a href="#x" style="position:absolute;left:20px;top:140px">lnk</a>
</div>
<script>
window.__ca = 0; window.__cb = 0;
document.getElementById('a').addEventListener('click', () => { window.__ca++; window.name = (window.name||'') + 'A'; });
document.getElementById('b').addEventListener('click', () => { window.__cb++; window.name = (window.name||'') + 'B'; });
if (new URLSearchParams(location.search).get('swap') === '1') {
  document.getElementById('a').style.top = '80px';
  document.getElementById('b').style.top = '20px';
}
</script></body>`;

const PAGE_MUT = `<!doctype html><title>adv17-mut</title><body>
<div id="g" data-g="0"><span>gen0</span></div>
<div id="btns"></div>
<iframe srcdoc="<body><div id=fg data-g=0><button>fg0</button></div><scr` + `ipt>let g=0;setInterval(()=>{g++;document.getElementById('fg').dataset.g=g;document.querySelector('button').textContent='fg'+g},4)</scr` + `ipt></body>"></iframe>
<script>
document.getElementById('btns').innerHTML = Array.from({length:60},(_,i)=>'<button id="m'+i+'">m'+i+' gen0</button>').join('');
window.__gen = 0;
window.__mt = setInterval(() => {
  const g = ++window.__gen;
  document.getElementById('g').dataset.g = g;
  document.getElementById('g').innerHTML = '<span>gen' + g + '</span>';
  for (let i = 0; i < 60; i++) { const b = document.getElementById('m'+i); if (b) b.textContent = 'm'+i+' gen'+g; }
}, 3);
</script></body>`;

export function startServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(u.pathname === '/mut' ? PAGE_MUT : PAGE_P);
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

export class Tabs {
  constructor() { this.mine = new Set(); }
  track(r) { const p = r && r.sc && r.sc.pageId; if (p) this.mine.add(p); return p; }
  async closeAll(sess) {
    for (const p of [...this.mine]) {
      const r = await sess.call('close_page', { pageId: p }).catch(() => null);
      if (r && (r.ok || /no such page/i.test(r.text || ''))) this.mine.delete(p);
    }
  }
}
