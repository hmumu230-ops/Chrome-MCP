// adv-05b-followup.mjs — focused retests: drag to_uid injection, hidden-el click via CDP,
// includeSnapshot side-effect, upload_file nonexistent-path state.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv05b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => { const t0 = Date.now(); try { const r = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }); r.ms = Date.now() - t0; return r; } catch (e) { return { ms: Date.now() - t0, threw: String(e && e.message || e) }; } };
const J = r => { try { const s = r.msg.result.structuredContent; if (s !== undefined) return s; } catch {} try { return JSON.parse(r.msg.result.content[0].text); } catch { return undefined; } };
const S = r => {
  if (r.threw) return 'THREW ' + r.threw;
  const m = r.msg; if (!m) return 'NO-MSG';
  if (m.error) return 'RPCERR ' + JSON.stringify(m.error).slice(0, 160);
  const res = m.result; if (!res) return 'NORES';
  const t = ((res.content && res.content[0] && res.content[0].text) || '').replace(/\s+/g, ' ');
  return (res.isError ? 'ERR ' : 'ok  ') + t.slice(0, 150);
};
const L = (name, r) => console.log(`${String(r.ms ?? 0).padStart(5)}ms ${name.padEnd(52)} ${S(r)}`);
const ev = async (pid, fn) => { const r = await call('evaluate_script', { pageId: pid, function: fn }); const j = J(r); return j && j.result !== undefined ? j.result : { __err: S(r) }; };

// draggable elements need uids -> tabindex makes them INTERACTIVE
const HTML = `<div id="t">
<a id="lnk" href="#nav1">NormalLink</a>
<a id="corner" href="#cornerhit" style="position:fixed;top:0;left:0;padding:3px;background:#ffd">CornerLink</a>
<input id="ti" type="text" placeholder="tinput">
<input id="fi" type="file">
<div id="hid" style="display:none">hidden</div>
<button id="btn">PushMe</button>
<div id="drag1" draggable="true" tabindex="0">drag1</div>
<div id="drop1" tabindex="0">drop1</div>
<div id="drop2" tabindex="0" style="position:fixed;right:0;top:0">drop2</div>
</div>`;
const INJECT = `() => {
  document.body.innerHTML = ${JSON.stringify(HTML)};
  window.__log = [];
  const lg = s => { try { __log.push(s); } catch {} };
  ['click','dblclick','dragstart','drop'].forEach(t => document.addEventListener(t, e => lg(t + ':' + (e.target.id || e.target.tagName) + ':' + (e.isTrusted ? 'T' : 'F')), true));
  window.alert = m => lg('ALERT:' + m);
  return 1;
}`;
const LOG = `() => (window.__log || []).slice(-40)`;
const uidMapFn = `() => Array.from(document.querySelectorAll('[data-mcp-uid]')).map(e => (e.id || e.tagName) + '|' + e.getAttribute('data-mcp-uid')).join('\\n')`;

const p1 = J(await call('new_page', { url: 'https://example.com' }));
const pid = p1.pageId;
console.log('pid=' + pid);
await call('evaluate_script', { pageId: pid, function: INJECT });
await call('take_snapshot', { pageId: pid });
const U = {}; for (const line of String(await ev(pid, uidMapFn)).split('\n')) { const [id, u] = line.split('|'); if (id && u) U[id] = u; }
console.log('uids=' + JSON.stringify(U));
L('attach debugger', await call('list_console_messages', { pageId: pid }));
L('select_page', await call('select_page', { pageId: pid }));

console.log('--- drag (now with uids) ---');
L('drag drag1->drop1 valid', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: U.drop1 }));
L('drag drag1->drag1 (same)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: U.drag1 }));
L('drag e999->drop1 (bad from)', await call('drag', { pageId: pid, from_uid: 'e999', to_uid: U.drop1 }));
L('drag drag1->e999 (bad to)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: 'e999' }));
L('drag drag1->INJECT `"],#drop2,[x="`', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: '"],#drop2,[x="' }));
L('drag drag1->INJECT `"],#hid,[x="` (uid-less hidden el)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: '"],#hid,[x="' }));
L('drag missing to_uid', await call('drag', { pageId: pid, from_uid: U.drag1 }));
console.log('   log: ' + JSON.stringify(await ev(pid, LOG)));

console.log('--- hidden element click (CDP path check) ---');
await call('evaluate_script', { pageId: pid, function: `() => { document.getElementById('btn').style.display = 'none'; return 1; }` });
await call('evaluate_script', { pageId: pid, function: `() => { window.__log = []; return 1; }` });
const rc = await call('click', { pageId: pid, uid: U.btn });
L('click uid of display:none #btn', rc);
console.log('   hash=' + (await ev(pid, '() => location.hash')) + ' log: ' + JSON.stringify(await ev(pid, LOG)));

console.log('--- includeSnapshot side-effect check ---');
await call('evaluate_script', { pageId: pid, function: `() => { window.__log = []; location.hash = ''; return 1; }` });
L('click lnk includeSnapshot:true', await call('click', { pageId: pid, uid: U.lnk, includeSnapshot: true }));
console.log('   (did the click still happen?) log: ' + JSON.stringify(await ev(pid, LOG)) + ' hash=' + (await ev(pid, '() => location.hash')));
L('hover includeSnapshot:true', await call('hover', { pageId: pid, uid: U.lnk, includeSnapshot: true }));
L('scroll includeSnapshot:true', await call('scroll', { pageId: pid, to: 'top', includeSnapshot: true }));

console.log('--- upload_file state after nonexistent path ---');
await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['D:\\no_such_zzz_123.txt'] });
console.log('   fi.files: ' + JSON.stringify(await ev(pid, '() => Array.from(document.getElementById("fi").files).map(f => f.name + ":" + f.size)')));
await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['C:\\Windows'] });
console.log('   fi.files after dir: ' + JSON.stringify(await ev(pid, '() => Array.from(document.getElementById("fi").files).map(f => f.name + ":" + f.size)')));
L('upload_file traversal ..\\..\\', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['..\\..\\Windows\\win.ini'] }));
console.log('   fi.files: ' + JSON.stringify(await ev(pid, '() => Array.from(document.getElementById("fi").files).map(f => f.name + ":" + f.size)')));

console.log('--- cleanup ---');
L('close_page ' + pid, await call('close_page', { pageId: pid }));
console.log('DONE');
process.exitCode = 0;
