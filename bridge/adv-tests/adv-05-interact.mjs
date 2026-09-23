// adv-05-interact.mjs — adversarial fuzz of interaction tools.
// Target: chrome-mcp bridge @ 127.0.0.1:7890/mcp (extension CONNECTED).
// Only closes tabs it created. Prints one line per call: ms, name, result.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  return { msg: m[m.length - 1], status: r.status, raw: t.slice(0, 200) };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv05', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (n, a) => { const t0 = Date.now(); try { const r = await rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } }); r.ms = Date.now() - t0; return r; } catch (e) { return { ms: Date.now() - t0, threw: String(e && e.message || e) }; } };
const J = r => { try { const s = r.msg.result.structuredContent; if (s !== undefined) return s; } catch {} try { return JSON.parse(r.msg.result.content[0].text); } catch { return undefined; } };
const S = r => {
  if (r.threw) return 'THREW ' + r.threw;
  const m = r.msg; if (!m) return 'NO-MSG status=' + r.status + ' ' + r.raw;
  if (m.error) return 'RPCERR ' + JSON.stringify(m.error).slice(0, 160);
  const res = m.result; if (!res) return 'NORES ' + JSON.stringify(m).slice(0, 160);
  const t = ((res.content && res.content[0] && res.content[0].text) || '').replace(/\s+/g, ' ');
  return (res.isError ? 'ERR ' : 'ok  ') + t.slice(0, 165);
};
const L = (name, r, extra = '') => console.log(`${String(r.ms ?? 0).padStart(5)}ms ${name.padEnd(48)} ${S(r)}${extra}`);
const ev = async (pid, fn) => { const r = await call('evaluate_script', { pageId: pid, function: fn }); const j = J(r); return j && j.result !== undefined ? j.result : { __err: S(r) }; };

// ---------- test DOM injected into example.com (setup only, not fuzzed) ----------
const HTML = `<div id="t">
<a id="lnk" href="#nav1">NormalLink</a>
<a id="corner" href="#cornerhit" style="position:fixed;top:0;left:0;padding:3px;background:#ffd">CornerLink</a>
<input id="ti" type="text" placeholder="tinput">
<textarea id="ta" placeholder="tainput"></textarea>
<select id="sel"><option value="a">optA</option><option value="b">optB</option></select>
<label><input id="cb" type="checkbox">chk</label>
<label><input id="rb" type="radio">rad</label>
<input id="fi" type="file">
<input id="fi2" type="file" style="display:none">
<div id="ed" contenteditable="true" style="border:1px solid">editme</div>
<div id="hid" style="display:none">hidden text here</div>
<button id="btn">PushMe</button>
<div id="drag1" draggable="true">drag1</div>
<div id="drop1">drop1</div>
<form id="frm" onsubmit="event.preventDefault();window.__log.push('formsubmit')"><input id="finput" type="text" placeholder="finput"></form>
</div>`;
const INJECT = `() => {
  document.body.innerHTML = ${JSON.stringify(HTML)};
  window.__log = [];
  const lg = s => { try { __log.push(s); } catch {} };
  ['click','dblclick','dragstart','drop','submit'].forEach(t => document.addEventListener(t, e => lg(t + ':' + (e.target.id || e.target.tagName || '?') + ':' + (e.isTrusted ? 'T' : 'F')), true));
  document.addEventListener('keydown', e => lg('key:' + e.key + ':' + (e.target.id || e.target.tagName) + ':' + (e.isTrusted ? 'T' : 'F')), true);
  window.alert = m => lg('ALERT:' + m);
  window.onerror = m => lg('ONERR:' + m);
  return document.querySelectorAll('#t *').length;
}`;
const LOG = `() => (window.__log || []).slice(-120)`;
const uidMapFn = `() => Array.from(document.querySelectorAll('[data-mcp-uid]')).map(e => (e.id || e.tagName) + '|' + e.getAttribute('data-mcp-uid')).join('\\n')`;
const parseUids = s => { const m = {}; for (const line of String(s || '').split('\n')) { const [id, u] = line.split('|'); if (id && u) m[id] = u; } return m; };

const myTabs = [];
console.log('=== SETUP ===');
const p1 = J(await call('new_page', { url: 'https://example.com' }));
const pid = p1.pageId; myTabs.push(pid);
console.log('tab1 pageId=' + pid);
L('inject DOM', await call('evaluate_script', { pageId: pid, function: INJECT }));
L('take_snapshot', await call('take_snapshot', { pageId: pid }));
const U = parseUids(await ev(pid, uidMapFn));
console.log('uids: ' + JSON.stringify(U));
L('attach debugger (list_console_messages)', await call('list_console_messages', { pageId: pid }));
L('select_page tab1 (active for CDP path)', await call('select_page', { pageId: pid }));

console.log('\n=== A. uid fuzz on click (post-snapshot => stale-uid guard) ===');
for (const u of ['e0', 'e999', 'f-1e1', 'e-1', '', null, {}, 'e1 OR 1=1', '<img src=x onerror=alert(1)>', '../../etc', 'constructor', '__proto__', 'hasOwnProperty'])
  L('click uid=' + JSON.stringify(u), await call('click', { pageId: pid, uid: u }));
L('click (uid missing)', await call('click', { pageId: pid }));
L('hover uid=e999', await call('hover', { pageId: pid, uid: 'e999' }));
L('click real uid (baseline)', await call('click', { pageId: pid, uid: U.lnk }));
console.log('   log: ' + JSON.stringify(await ev(pid, LOG)));

console.log('\n=== B. hidden-after-snapshot element click (CDP hits coords 0,0?) ===');
L('hide #btn', await call('evaluate_script', { pageId: pid, function: `() => { document.getElementById('btn').style.display = 'none'; return 1; }` }));
L('click uid of now-hidden #btn', await call('click', { pageId: pid, uid: U.btn }));
console.log('   hash=' + (await ev(pid, '() => location.hash')) + ' log: ' + JSON.stringify(await ev(pid, LOG)));

console.log('\n=== C. fill ===');
L('fill ti "hello"', await call('fill', { pageId: pid, uid: U.ti, value: 'hello' }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill ti value=123 (number)', await call('fill', { pageId: pid, uid: U.ti, value: 123 }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill ti value={a:1} (object)', await call('fill', { pageId: pid, uid: U.ti, value: { a: 1 } }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill ti value=null', await call('fill', { pageId: pid, uid: U.ti, value: null }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill ti (value missing)', await call('fill', { pageId: pid, uid: U.ti }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
const big = 'A'.repeat(1048576);
const rBig = await call('fill', { pageId: pid, uid: U.ti, value: big });
L('fill ti 1MB string', rBig);
console.log('   ti.value.length=' + (await ev(pid, '() => document.getElementById("ti").value.length')));
L('fill ti emoji/null/newline', await call('fill', { pageId: pid, uid: U.ti, value: 'emo😀\u0000NUL\nNL\r\n\t𝕏' }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill uid=<a> link (non-input)', await call('fill', { pageId: pid, uid: U.lnk, value: 'x' }));
L('fill uid=<button> (non-input)', await call('fill', { pageId: pid, uid: U.btn, value: 'x' }));
L('fill uid=file input', await call('fill', { pageId: pid, uid: U.fi, value: 'C:\\\\evil.exe' }));
L('fill select bad option "zzz"', await call('fill', { pageId: pid, uid: U.sel, value: 'zzz' }));
L('fill select good option "b"', await call('fill', { pageId: pid, uid: U.sel, value: 'b' }));
console.log('   sel.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("sel").value')));
L('fill checkbox value="maybe"', await call('fill', { pageId: pid, uid: U.cb, value: 'maybe' }));
console.log('   cb.checked=' + (await ev(pid, '() => document.getElementById("cb").checked')));
L('fill uid=e999 (stale)', await call('fill', { pageId: pid, uid: 'e999', value: 'x' }));

console.log('\n=== D. fill_form ===');
L('fill_form elements=[]', await call('fill_form', { pageId: pid, elements: [] }));
L('fill_form elements={} (object)', await call('fill_form', { pageId: pid, elements: { uid: U.ti, value: 'x' } }));
L('fill_form elements="str"', await call('fill_form', { pageId: pid, elements: 'str' }));
L('fill_form elements=123', await call('fill_form', { pageId: pid, elements: 123 }));
L('fill_form (elements missing)', await call('fill_form', { pageId: pid }));
L('fill_form [{uid,no value}]', await call('fill_form', { pageId: pid, elements: [{ uid: U.ti }] }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
L('fill_form [{no uid,value}]', await call('fill_form', { pageId: pid, elements: [{ value: 'v' }] }));
L('fill_form same uid x2', await call('fill_form', { pageId: pid, elements: [{ uid: U.ti, value: 'first' }, { uid: U.ti, value: 'second' }] }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
const many = []; for (let k = 0; k < 100; k++) many.push({ uid: U.ti, value: 'v' + k });
const r100 = await call('fill_form', { pageId: pid, elements: many });
L('fill_form 100 elements', r100);
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')) + ' okCount=' + (J(r100)?.results || []).filter(x => x.ok).length);
L('fill_form [{uid:e999}]', await call('fill_form', { pageId: pid, elements: [{ uid: 'e999', value: 'x' }] }));
L('fill_form mixed good+bad', await call('fill_form', { pageId: pid, elements: [{ uid: U.ti, value: 'g' }, { uid: 'e999', value: 'b' }] }));

console.log('\n=== E. click_xy ===');
L('click_xy 0,0', await call('click_xy', { pageId: pid, x: 0, y: 0 }));
console.log('   hash=' + (await ev(pid, '() => location.hash')));
L('click_xy -50,-50', await call('click_xy', { pageId: pid, x: -50, y: -50 }));
L('click_xy 1e9,1e9', await call('click_xy', { pageId: pid, x: 1e9, y: 1e9 }));
L('click_xy "a","b"', await call('click_xy', { pageId: pid, x: 'a', y: 'b' }));
L('click_xy null,null (missing)', await call('click_xy', { pageId: pid }));
console.log('   hash=' + (await ev(pid, '() => location.hash')) + ' log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-6)));
L('click_xy {},{}', await call('click_xy', { pageId: pid, x: {}, y: {} }));
L('click_xy 200,200 dblClick', await call('click_xy', { pageId: pid, x: 200, y: 200, dblClick: true }));

console.log('\n=== F. type_text ===');
L('blur active element', await call('evaluate_script', { pageId: pid, function: `() => { const a = document.activeElement; if (a && a.blur) a.blur(); return document.activeElement.tagName; }` }));
L('type_text nothing focused', await call('type_text', { pageId: pid, text: 'abc' }));
L('focus ti', await call('evaluate_script', { pageId: pid, function: `() => { document.getElementById('ti').focus(); return document.activeElement.id; }` }));
L('type_text "hi"', await call('type_text', { pageId: pid, text: 'hi' }));
console.log('   ti.value=' + JSON.stringify(await ev(pid, '() => document.getElementById("ti").value')));
const rt1m = await call('type_text', { pageId: pid, text: 'B'.repeat(1048576) });
L('type_text 1MB', rt1m);
console.log('   ti.value.length=' + (await ev(pid, '() => document.getElementById("ti").value.length')));
L('type_text ctrl chars', await call('type_text', { pageId: pid, text: 'a\u0000b\u0007c\u001bd' }));
L('type_text text=null', await call('type_text', { pageId: pid, text: null }));
L('type_text text=123', await call('type_text', { pageId: pid, text: 123 }));
L('focus finput (inside form)', await call('evaluate_script', { pageId: pid, function: `() => { document.getElementById('finput').focus(); return document.activeElement.id; }` }));
L('type_text submitKey=Enter', await call('type_text', { pageId: pid, text: 'zz', submitKey: 'Enter' }));
console.log('   log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-8)));

console.log('\n=== G. press_key ===');
L('press_key Enter (finput focused, in form)', await call('press_key', { pageId: pid, key: 'Enter' }));
console.log('   log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-6)));
L('press_key "NotAKey"', await call('press_key', { pageId: pid, key: 'NotAKey' }));
L('press_key "control+++"', await call('press_key', { pageId: pid, key: 'control+++' }));
L('press_key ""', await call('press_key', { pageId: pid, key: '' }));
L('press_key key=null', await call('press_key', { pageId: pid, key: null }));
L('press_key Escape', await call('press_key', { pageId: pid, key: 'Escape' }));
L('press_key Control+A', await call('press_key', { pageId: pid, key: 'Control+A' }));
L('press_key Control+Alt+Delete', await call('press_key', { pageId: pid, key: 'Control+Alt+Delete' }));
console.log('   log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-10)));

console.log('\n=== H. scroll ===');
L('scroll uid=drag1 (valid)', await call('scroll', { pageId: pid, uid: U.drag1 }));
L('scroll uid="" (empty, falsy)', await call('scroll', { pageId: pid, uid: '' }));
L('scroll uid=e999', await call('scroll', { pageId: pid, uid: 'e999' }));
L('scroll to="sideways" (bad enum)', await call('scroll', { pageId: pid, to: 'sideways' }));
L('scroll to="top"', await call('scroll', { pageId: pid, to: 'top' }));
L('scroll dx="NaN" dy="NaN"', await call('scroll', { pageId: pid, dx: 'NaN', dy: 'NaN' }));
L('scroll dy=1e18', await call('scroll', { pageId: pid, dy: 1e18 }));
L('scroll (no args)', await call('scroll', { pageId: pid }));
console.log('   scrollY=' + (await ev(pid, '() => scrollY')));

console.log('\n=== I. drag ===');
L('drag drag1->drop1 (valid)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: U.drop1 }));
L('drag drag1->drag1 (same)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: U.drag1 }));
L('drag e999->drop1', await call('drag', { pageId: pid, from_uid: 'e999', to_uid: U.drop1 }));
L('drag drag1->e999 (bad to_uid)', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: 'e999' }));
L('drag drag1->INJECT #hid', await call('drag', { pageId: pid, from_uid: U.drag1, to_uid: '"],#hid,[x="' }));
L('drag (missing to_uid)', await call('drag', { pageId: pid, from_uid: U.drag1 }));
console.log('   log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-10)));

console.log('\n=== J. upload_file ===');
L('upload_file fi win.ini', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['C:\\Windows\\win.ini'] }));
console.log('   fi.files[0]=' + JSON.stringify(await ev(pid, '() => { const f = document.getElementById("fi"); return f.files.length ? f.files[0].name : null; }')));
L('upload_file fi nonexistent path', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['D:\\no_such_zzz_123.txt'] }));
L('upload_file fi directory C:\\Windows', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: ['C:\\Windows'] }));
L('upload_file uid=<a> link', await call('upload_file', { pageId: pid, uid: U.lnk, filePaths: ['C:\\Windows\\win.ini'] }));
L('upload_file uid=e999', await call('upload_file', { pageId: pid, uid: 'e999', filePaths: ['C:\\Windows\\win.ini'] }));
L('upload_file INJECT hidden fi2', await call('upload_file', { pageId: pid, uid: '"],input[type=file][style],[x="', filePaths: ['C:\\Windows\\win.ini'] }));
console.log('   fi2(hidden).files[0]=' + JSON.stringify(await ev(pid, '() => { const f = document.getElementById("fi2"); return f.files.length ? f.files[0].name : null; }')));
L('upload_file filePaths="str" (not array)', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: 'C:\\Windows\\win.ini' }));
L('upload_file filePaths=[] ', await call('upload_file', { pageId: pid, uid: U.fi, filePaths: [] }));

console.log('\n=== K. cross-tab uid + no-snapshot injection ===');
const p2 = J(await call('new_page', { url: 'https://example.com', background: true }));
const pid2 = p2.pageId; myTabs.push(pid2);
console.log('tab2 pageId=' + pid2);
L('tab2 inject DOM (+extra link)', await call('evaluate_script', { pageId: pid2, function: INJECT.replace('</div>', '<a id="extra" href="#x">ExtraLink</a></div>') }));
L('tab2 snapshot', await call('take_snapshot', { pageId: pid2 }));
const U2 = parseUids(await ev(pid2, uidMapFn));
console.log('   tab2 uids: ' + JSON.stringify(U2));
L('click tab1 w/ tab2-only uid (extra=' + U2.extra + ')', await call('click', { pageId: pid, uid: U2.extra }));
L('click tab1 w/ colliding uid e1', await call('click', { pageId: pid, uid: 'e1' }));
console.log('   tab1 log tail: ' + JSON.stringify((await ev(pid, LOG)).slice(-5)));
// tab3: never snapshotted -> no frameMap -> checkUid inert -> find() selector injection
const p3 = J(await call('new_page', { url: 'https://example.com', background: true }));
const pid3 = p3.pageId; myTabs.push(pid3);
console.log('tab3 pageId=' + pid3 + ' (NO snapshot)');
L('tab3 inject DOM', await call('evaluate_script', { pageId: pid3, function: INJECT }));
L('tab3 click INJECT `"],a,[x="`', await call('click', { pageId: pid3, uid: '"],a,[x="' }));
console.log('   tab3 log: ' + JSON.stringify(await ev(pid3, LOG)) + ' hash=' + (await ev(pid3, '() => location.hash')));
L('tab3 fill INJECT `"],#ti,[x="`', await call('fill', { pageId: pid3, uid: '"],#ti,[x="', value: 'INJECTED' }));
console.log('   tab3 ti.value=' + JSON.stringify(await ev(pid3, '() => document.getElementById("ti").value')));
L('tab3 press_key x (background tab, hasFocus false)', await call('press_key', { pageId: pid3, key: 'x' }));
console.log('   tab3 key events logged: ' + JSON.stringify((await ev(pid3, LOG)).filter(s => s.startsWith('key'))));
// Control+W needs debugger + active tab on tab3
L('tab3 attach debugger (upload_file bad uid)', await call('upload_file', { pageId: pid3, uid: 'zz', filePaths: ['x'] }));
L('select_page tab3', await call('select_page', { pageId: pid3 }));
L('tab3 press_key Control+W', await call('press_key', { pageId: pid3, key: 'Control+W' }));
const lp = J(await call('list_pages', {}));
const t3alive = (lp?.items || lp || []).some(t => t.pageId === pid3);
console.log('   tab3 alive after Ctrl+W: ' + t3alive);
L('press_key F12 (on whichever tab)', await call('press_key', { pageId: pid3, key: 'F12' }));
L('reselect tab1', await call('select_page', { pageId: pid }).catch(() => ({ ms: 0, threw: 'gone' })));

console.log('\n=== L. misc ===');
L('click lnk dblClick:true', await call('click', { pageId: pid, uid: U.lnk, dblClick: true }));
console.log('   hash=' + (await ev(pid, '() => location.hash')) + ' clicks on lnk: ' + JSON.stringify((await ev(pid, LOG)).filter(s => s.includes('lnk'))));
const rSnap = await call('click', { pageId: pid, uid: U.lnk, includeSnapshot: true });
L('click lnk includeSnapshot:true', rSnap);
console.log('   snapshot lines returned: ' + ((J(rSnap)?.snapshot?.lines) || []).length);
L('hover real uid', await call('hover', { pageId: pid, uid: U.lnk }));

console.log('\n=== M. final integrity ===');
const fin = await ev(pid, `() => ({ h1: document.querySelector('h1') ? 'h1-ok' : 'no-h1', alerts: (window.__log || []).filter(s => s.startsWith('ALERT')), onerrs: (window.__log || []).filter(s => s.startsWith('ONERR')), hash: location.hash, tiLen: document.getElementById('ti').value.length })`);
console.log('integrity: ' + JSON.stringify(fin));
console.log('\n=== cleanup: closing my tabs ' + JSON.stringify(myTabs) + ' ===');
for (const t of myTabs) L('close_page ' + t, await call('close_page', { pageId: t }));
console.log('DONE');
process.exitCode = 0;
