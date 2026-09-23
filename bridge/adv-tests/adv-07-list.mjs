// adv-07-list.mjs — compact list_pages with retry (rogue /ws clients steal the
// extension slot; retry until the real extension answers).
const BASE = 'http://127.0.0.1:7890/mcp';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TRIES = Number(process.argv[2] || 1);
for (let attempt = 0; attempt < TRIES; attempt++) {
  let sid = null, i = 0;
  async function rpc(body, ms = 20000) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(BASE, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
      const text = await r.text(); if (!sid) sid = r.headers.get('mcp-session-id');
      const m = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } });
      return { msg: m.filter(Boolean).pop(), status: r.status, text };
    } catch (e) { return { status: -1, text: `CLIENT ${e.name}: ${e.message}`, msg: null }; }
    finally { clearTimeout(t); }
  }
  const call = (n, a, ms) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }, ms);
  const ir = await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'list', version: '0' } } });
  if (ir.status !== 200) { console.log(`attempt ${attempt}: init status ${ir.status}`); await sleep(5000); continue; }
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const r = await call('list_pages', {});
  const txt = r.msg && r.msg.result && r.msg.result.content && r.msg.result.content[0] && r.msg.result.content[0].text || (r.text || '').slice(0, 200);
  let tabs; try { tabs = JSON.parse(txt); } catch { tabs = null; }
  if (Array.isArray(tabs)) {
    for (const t of tabs) console.log(`${t.pageId}\t${t.active ? 'A' : '-'}\t${String(t.url).slice(0, 90)}`);
    process.exit(0);
  }
  console.log(`attempt ${attempt}: ${String(txt).slice(0, 120)}`);
  await sleep(5000);
}
process.exit(1);
