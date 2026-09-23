// adv-07-recover.mjs — wait for a stable extension window, list tabs, probe
// example.com tabs, close MY leftovers: tabA=301370768 and the while(1)-wedged
// tab created right after it (evaluate on it will hang/error).
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MY_KNOWN = new Set([301370768]);           // adv-07e tabA
const CANDIDATE_RANGE = [301370760, 301370810];  // while(1) tab was created just after tabA

async function rpc(body, sid, ms = 20000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); const nsid = r.headers.get('mcp-session-id') || sid;
    const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
    return { msg: m.filter(Boolean).pop(), status: r.status, text, sid: nsid };
  } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msg: null, sid }; }
  finally { clearTimeout(t); }
}

async function session() {
  const ir = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv07-rec', version: '0' } } });
  if (ir.status !== 200 || !ir.sid) return null;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ir.sid);
  return ir.sid;
}
async function call(sid, n, a, ms) {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: n, arguments: a } }, sid, ms);
  const m = r.msg;
  if (!m) return { err: 'NO-MSG ' + (r.text || '').slice(0, 100) };
  const res = m.result; if (!res) return { err: 'NO-RESULT' };
  const txt = res.content && res.content[0] && res.content[0].text || '';
  if (res.isError) return { err: txt.slice(0, 200) };
  try { return { data: JSON.parse(txt) }; } catch { return { data: txt }; }
}

let sid = null, tabs = null;
for (let k = 0; k < 40 && !tabs; k++) {
  sid = await session();
  if (!sid) { console.log(`try ${k}: no session`); await sleep(4000); continue; }
  const lp = await call(sid, 'list_pages', {}, 15000);
  if (lp.err) { console.log(`try ${k}: ${lp.err.slice(0, 80)}`); await sleep(4000); continue; }
  tabs = lp.data;
}
if (!tabs) { console.log('FAILED to get a stable window'); process.exit(1); }
for (const t of tabs) console.log(`${t.pageId}\t${t.url.slice(0, 80)}`);

// close the known-mine tab first
for (const id of [...MY_KNOWN]) {
  if (tabs.some(t => t.pageId === id)) {
    const c = await call(sid, 'close_page', { pageId: id }, 15000);
    console.log(`close known-mine ${id} -> ${c.err || JSON.stringify(c.data)}`);
  }
}
// probe candidate-range example.com tabs for the wedged one
for (const t of tabs) {
  if (MY_KNOWN.has(t.pageId)) continue;
  if (t.pageId < CANDIDATE_RANGE[0] || t.pageId > CANDIDATE_RANGE[1]) continue;
  if (!/example\.com/.test(t.url)) continue;
  const t0 = Date.now();
  const pr = await call(sid, 'evaluate_script', { pageId: t.pageId, function: '() => 1' }, 6000);
  const dt = Date.now() - t0;
  console.log(`probe ${t.pageId} ${t.url.slice(0, 50)} -> ${pr.err ? 'ERR ' + pr.err.slice(0, 80) : JSON.stringify(pr.data)} (${dt}ms)`);
  if (dt >= 5500 || (pr.err && !/not connected|No tab/.test(pr.err))) {
    const c = await call(sid, 'close_page', { pageId: t.pageId }, 15000);
    console.log(`  ^^ wedged? closing -> ${c.err || JSON.stringify(c.data)}`);
  }
}
console.log('recovery done');
