// Round-3 verification — fixes driven by production log analysis:
//   22x screenshot CDP timeout + 11x "Only screenshots from surface"
//   12x take_snapshot + 4x fill/click "extension call timeout" (wedged renderer)
//   6x  "pageId must be an integer" (clients sending string ids)
//   session pool exhaustion -> 503 storms (multi-agent clients)
//   evaluate_script timeout message ambiguity (non-cancelling)
import { setTimeout as sleep } from 'node:timers/promises';
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('PASS', name, detail); } else { fail++; console.log('FAIL', name, detail); } };

async function req(method, params = {}, session = undefined) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  const useSid = session === undefined ? sid : session;
  if (useSid) headers['mcp-session-id'] = useSid;
  const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
async function call(tool, args = {}) {
  const { body } = await (async () => {
    const r = await req('tools/call', { name: tool, arguments: args });
    if (!sid) sid = r.headers.get('mcp-session-id');
    const dl = r.text.split('\n').find(l => l.startsWith('data: '));
    return { status: r.status, body: JSON.parse(dl ? dl.slice(6) : r.text) };
  })();
  if (body.error) return { isError: true, text: 'RPC ' + body.error.code + ': ' + body.error.message, sc: null, raw: body };
  const res = body.result || {};
  const text = res.content && res.content[0] && res.content[0].text || '';
  return { isError: !!res.isError, text, sc: res.structuredContent, raw: res };
}

const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reg3', version: '1' } });
sid = init.headers.get('mcp-session-id');
ok('initialize', !!sid);

const np = await call('new_page', { url: 'https://example.com', background: true });
ok('new_page', !np.isError, np.text.slice(0, 60));
const pid = np.sc && np.sc.pageId;
if (!pid) { console.log('no pageId — aborting'); process.exit(1); }
await sleep(1500);

// T1 string pageId coercion (production: 6x "pageId must be an integer")
let r = await call('take_snapshot', { pageId: String(pid) });
ok('string pageId accepted', !r.isError && /Example Domain|示例域|example\.com/i.test(r.text), r.text.slice(0, 90));
r = await call('close_page', { pageId: String(pid) });
ok('string pageId close_page', !r.isError, r.text.slice(0, 80));
// reopen — the test tab is gone now
const np2 = await call('new_page', { url: 'https://example.com', background: true });
const pid2 = np2.sc && np2.sc.pageId;
ok('reopen test tab', !!pid2);
await sleep(1200);

// T2 eval timeout message explains non-cancellation (production: ambiguity)
r = await call('evaluate_script', { pageId: pid2, function: '() => new Promise(()=>{})', timeout: 1500 });
ok('eval timeout names non-cancel', r.isError && /NOT cancelled/i.test(r.text) && /keeps running/i.test(r.text), r.text.slice(0, 120));

// T3 screenshot after fromSurface removal — bg-tab CDP path + fullPage
r = await call('take_screenshot', { pageId: pid2 });
ok('bg tab screenshot', !r.isError, (r.raw.content || []).map(c => c.type).join(','));
r = await call('take_screenshot', { pageId: pid2, fullPage: true, format: 'jpeg' });
ok('fullPage jpeg', !r.isError, (r.raw.content || []).map(c => c.type).join(','));

// T4 save_pdf with new 60s bound still works
r = await call('save_pdf', { pageId: pid2 });
ok('save_pdf', !r.isError && /bytes|file/i.test(r.text), r.text.slice(0, 80));

// T5 wedged renderer: sync infinite loop blocks the main thread; a later
// executeScript queues forever — new 45s bound must fire WELL under the old
// 120s extension-call ceiling instead of hanging the whole call.
r = await call('evaluate_script', { pageId: pid2, function: '() => { const s=Date.now(); while(Date.now()-s<90000){} }', timeout: 2000 });
ok('wedge loop eval times out', r.isError && /timeout/i.test(r.text), r.text.slice(0, 90));
const t0 = Date.now();
r = await call('take_snapshot', { pageId: pid2 });
const wedgedMs = Date.now() - t0;
ok('snapshot on wedged tab bounded', r.isError && wedgedMs < 110000, `${wedgedMs}ms ${r.text.slice(0, 80)}`);
ok('wedged error is explanatory', r.isError && /unresponsive|dialog|timeout/i.test(r.text), r.text.slice(0, 110));
await call('close_page', { pageId: pid2 });

// T6 session pool: fill to MAX (50) then one more — must NOT 503 anymore.
// NOTE: evicts exactly one least-recently-used real session (acceptable per
// design — its next request re-initializes per spec).
const sids = [];
for (let i = 0; i < 51; i++) {
  const ir = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reg3flood', version: '1' } }, null);
  const h = ir.headers.get('mcp-session-id');
  if (h) sids.push(h);
}
ok('51 sessions initialized (no 503)', sids.length === 51, `got ${sids.length}`);
const ir = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reg3flood', version: '1' } }, null);
ok('52nd initialize evicts LRU, no 503', ir.status !== 503 && !!ir.headers.get('mcp-session-id'), 'status=' + ir.status);
// clean up the flood sessions
for (const s of sids) { try { await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': s } }); } catch {} }

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
