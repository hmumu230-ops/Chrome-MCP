// adv-04 follow-up: cleanup leftovers + finish wait_for/close_page cases
// after the bridge died mid-run (rogue WS + process restart during adv-03 tests).
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const results = []; let n = 0;

const rpc = async (b, ms = 40000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(b),
    });
    const tx = await r.text();
    if (!sid) sid = r.headers.get('mcp-session-id');
    const m = tx.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
    return { msg: m[m.length - 1], status: r.status };
  } finally { clearTimeout(t); }
};
const call = (name, args, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name, arguments: args } }, ms);
function summarize(r) {
  if (!r || !r.msg) return 'NO-RESPONSE';
  const m = r.msg;
  if (m.error) return 'RPC-ERR ' + JSON.stringify(m.error).slice(0, 200);
  const res = m.result; if (res == null) return 'EMPTY';
  const txt = (res.content || []).map(c => c.text || '').join(' ').replace(/\s+/g, ' ').slice(0, 200);
  return (res.isError ? 'TOOL-ERR ' : 'OK ') + txt;
}
async function T(label, name, args, ms) {
  n++; const t0 = Date.now(); let r, err;
  try { r = await call(name, args, ms); } catch (e) { err = e; }
  const line = `[${String(n).padStart(2, '0')}] ${label}  (${Date.now() - t0}ms)  ${err ? 'CLIENT-ERR ' + err.name + ':' + (err.cause ? err.cause.code : err.message || '').slice(0, 90) : summarize(r)}`;
  console.log(line); results.push(line); return r;
}
const status = async () => (await (await fetch('http://127.0.0.1:7890/')).json());

await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('== status:', JSON.stringify(await status()));

// sanity: is the responder the REAL extension? real list_pages = real tabs.
const lp = await T('list_pages (sanity — real ext?)', 'list_pages', {});
const items = lp && lp.msg && lp.msg.result && lp.msg.result.structuredContent ? lp.msg.result.structuredContent.items : [];
console.log('    tabs:', items.map(t => `${t.pageId}:${(t.title || '').slice(0, 25)}`).join(' | '));

// close leftovers from aborted run (my tab ids) + any about:blank I made
const MINE = [301370230, 301370231, 301370232, 301370234];
for (const id of MINE) {
  if (items.find(t => t.pageId === id)) {
    await T(`close leftover ${id}`, 'close_page', { pageId: id });
  } else console.log(`    leftover ${id} already gone`);
}

// ---------- wait_for on a REAL page (was about:blank uninjectable?) ----------
const w = await call('new_page', { url: 'https://example.com' });
const W = w.msg.result.structuredContent.pageId;
await T('wait_for text=["Example"] on real page', 'wait_for', { pageId: W, text: ['Example'], timeout: 5000 });
await T("wait_for text=[''] on real page", 'wait_for', { pageId: W, text: [''], timeout: 3000 });
await T("wait_for textGone=['ZZZ'] real page", 'wait_for', { pageId: W, textGone: ['ZZZ'], timeout: 3000 });
await T("wait_for text='str' not array, real page", 'wait_for', { pageId: W, text: 'Example', timeout: 2000 });
// unbounded timeout leak demo: unmatchable + 1e9, abort client at 5s, then prove server+ext still responsive
const leak = call('wait_for', { pageId: W, text: ['ZZZ_NEVER_MATCH'], timeout: 1e9 }, 5000)
  .then(r => console.log('    >> leak returned:', summarize(r)))
  .catch(e => console.log(`    >> wait_for timeout=1e9 unmatchable: aborted at 5s (${e.name}) — ext loop presumably still polling`));
await new Promise(r => setTimeout(r, 6000));
await T('list_pages while leaked wait_for runs', 'list_pages', {});
await leak.catch(() => {});
await T('wait_for timeout=1e9 + MATCHING text (returns fast)', 'wait_for', { pageId: W, text: ['Example'], timeout: 1e9 });

// ---------- close_page edge cases (redo — bridge died last time) ----------
await T('close_page pageId=undefined', 'close_page', {});
await T('close_page pageId=999999', 'close_page', { pageId: 999999 });
const d = await call('new_page', { url: 'about:blank' });
const D = d.msg.result.structuredContent.pageId;
await T('close_page fresh tab', 'close_page', { pageId: D });
await T('close_page same tab AGAIN', 'close_page', { pageId: D });

// navigate back/forward on real history
await T('navigate type=back on real tab', 'navigate_page', { pageId: W, type: 'back' }, 15000);
await T('navigate type=forward', 'navigate_page', { pageId: W, type: 'forward' }, 15000);

// ---------- cleanup ----------
await T('RESTORE window 1400x900', 'resize_page', { pageId: W, width: 1400, height: 900 });
await T('close W tab', 'close_page', { pageId: W });
// restore original active tab if it still exists
const fin0 = await call('list_pages', {});
const fin0items = fin0.msg.result.structuredContent.items || [];
if (fin0items.find(t => t.pageId === 301370228)) await call('select_page', { pageId: 301370228 }).catch(() => {});

const fin = await call('list_pages', {});
const finItems = fin.msg.result.structuredContent.items || [];
console.log('\n== final status:', JSON.stringify(await status()));
console.log('== final tabs:', finItems.length, '->', finItems.map(t => `${t.pageId}:${(t.title || '').slice(0, 20)}`).join(' | '));
console.log('DONE');
