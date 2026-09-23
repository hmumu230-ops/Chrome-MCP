// adv05 shared MCP client: persistent session, sequential calls, retry on flap.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
let idc = 0;

async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dataLine || t); } catch { return { raw: t, status: res.status }; }
}

export async function init() {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv05', version: '0' } });
      if (r.result?.serverInfo) {
        await req('notifications/initialized', {});
        return r;
      }
      sid = null;
      await new Promise(r => setTimeout(r, 2000));
    } catch { sid = null; await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('init failed after retries');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function call(tool, args = {}, timeoutMs = 90000) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await req('tools/call', { name: tool, arguments: args });
      const res = r.result ?? r;
      if (res.status === 404 || res.status === 503) { // session lost / bridge restarted
        sid = null; await init(); continue;
      }
      const txt = res?.content?.[0]?.text ?? JSON.stringify(res);
      if (/not connected|extension disconnected|call timeout/i.test(txt) && i < 7) {
        last = { isError: true, text: txt };
        await sleep(1500 + i * 1000);
        continue;
      }
      return { isError: !!res?.isError, text: txt, structured: res?.structuredContent, raw: res };
    } catch (e) {
      last = { isError: true, text: 'fetch err: ' + e.message };
      sid = null;
      try { await init(); } catch {}
      await sleep(1000);
    }
  }
  return last;
}

// evaluate_script helper: unwraps {result: v}
export async function evl(pageId, fn, args) {
  const r = await call('evaluate_script', { pageId, function: fn, ...(args ? { args } : {}) });
  if (r.isError) return { __err: r.text };
  let o;
  try { o = JSON.parse(r.text); } catch { return r.text; }
  if (o && typeof o === 'object' && 'result' in o) return o.result;
  return o;
}

export function ok(name, cond, evidence = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  | ' + String(evidence).slice(0, 300) : ''}`);
  return cond;
}
