// Full-surface test of Chrome MCP: exercises every tool against a live page.
// Usage: node full-test.mjs   (requires bridge on :7890 + extension connected)
const BASE = 'http://127.0.0.1:7890/mcp';
const OUT = 'D:\\Tool\\chrome-mcp\\bridge\\test-out';
import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });

let sid;
let reqId = 0;
async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method, params }),
  });
  const text = await res.text();
  if (!sid) sid = res.headers.get('mcp-session-id');
  const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return msgs[msgs.length - 1];
}

let pass = 0, fail = 0, xfail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
function expectLimited(name, r, detail = '') {
  // Known platform limitation — counts separately, not as a failure.
  xfail++; console.log(`  XLIM  ${name}${detail ? '  — ' + detail : ''}`);
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message || JSON.stringify(r.error) };
  const res = r.result;
  if (res?.isError) return { error: res.content?.[0]?.text || 'isError' };
  return { result: res };
}
const textOf = (r) => r?.result?.content?.find(c => c.type === 'text')?.text || '';
const jsonOf = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
const uidOf = (snapshotResult, matchRe) => {
  const line = (jsonOf(snapshotResult)?.lines || []).find(l => matchRe.test(l));
  const m = line && line.match(/\[(e\d+|f\d+e\d+)\]/);
  return m && m[1];
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('== init ==');
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'full-test', version: '1' } });
check('initialize', !!init.result?.serverInfo, init.result?.serverInfo?.name);
await rpc('notifications/initialized', {});
const list = await rpc('tools/list', {});
check('tools/list = 37 tools', list.result?.tools?.length === 37, `${list.result?.tools?.length} tools`);

console.log('== page management ==');
let r = await call('list_pages');
const pagesBefore = jsonOf(r) || [];
check('list_pages', Array.isArray(pagesBefore), `${pagesBefore.length} tabs`);

r = await call('new_page', { url: 'https://example.com/' });
const pageId = jsonOf(r)?.pageId ?? jsonOf(r)?.id ?? jsonOf(r)?.tabId;
check('new_page', Number.isInteger(pageId), 'pageId=' + pageId);

r = await call('wait_for', { pageId, text: ['Example Domain'], timeout: 15000 });
check('wait_for text', !r.error, r.error || 'found');

r = await call('select_page', { pageId, bringToFront: true });
check('select_page', !r.error, r.error || '');

console.log('== perception ==');
r = await call('take_snapshot', { pageId });
const linkUid = uidOf(r, /link.*Learn more/i);
check('take_snapshot', !!linkUid, 'link uid=' + linkUid);

r = await call('extract_text', { pageId });
check('extract_text', /Example Domain/.test(textOf(r)), `${textOf(r).length} chars`);

// Inject test fixtures: form fields, button, file input, drag pair, spacer.
r = await call('evaluate_script', {
  pageId,
  function: `() => {
    const d = document.createElement('div');
    d.id = 'mcp-fixtures';
    d.innerHTML = '<input id="ti" type="text"><input id="cb" type="checkbox">' +
      '<select id="sel"><option value="a">A</option><option value="b">B</option></select>' +
      '<button id="btn">PushMe</button>' +
      '<input id="fi" type="file"><div id="sp" style="height:3000px"></div>' +
      '<div id="dropzone">DropZone</div><div id="dragme" draggable="true">DragMe</div>';
    document.body.appendChild(d);
    document.getElementById('btn').onclick = () => {
      document.body.setAttribute('data-clicked', 'YES');
      const s = document.createElement('div');
      s.id = 'clicked-note';
      s.textContent = 'CLICKED-NOTE';
      document.body.appendChild(s);
    };
    console.log('mcp-test-log-1');
    console.error('mcp-test-err-1');
    return 'fixtures-ready';
  }`,
});
check('evaluate_script inject fixtures', /fixtures-ready/.test(textOf(r)), r.error || textOf(r).slice(0, 60));

r = await call('take_snapshot', { pageId });
const snap2 = r;
const btnUid = uidOf(snap2, /PushMe/i);
const tiUid = uidOf(snap2, /textbox/i);
const cbUid = uidOf(snap2, /checkbox/i);
const selUid = uidOf(snap2, /combobox/i);
const fiUid = uidOf(snap2, /fileinput|file/i);
const dragUid = uidOf(snap2, /DragMe/i);
const dropUid = uidOf(snap2, /DropZone/i);
check('fixture uids in snapshot', !!(btnUid && tiUid && cbUid && selUid && fiUid), `btn=${btnUid} text=${tiUid} cb=${cbUid} sel=${selUid} file=${fiUid}`);

console.log('== interaction ==');
r = await call('fill', { pageId, uid: tiUid, value: 'hello-mcp' });
check('fill text input', !r.error, r.error || '');
r = await call('evaluate_script', { pageId, function: '() => document.getElementById("ti").value' });
check('  -> fill value verified', /hello-mcp/.test(textOf(r)), textOf(r).slice(0, 40));

r = await call('fill_form', { pageId, elements: [{ uid: cbUid, value: 'true' }, { uid: selUid, value: 'b' }] });
check('fill_form checkbox+select', !r.error, r.error || '');
r = await call('evaluate_script', { pageId, function: '() => document.getElementById("cb").checked + "/" + document.getElementById("sel").value' });
check('  -> form values verified', /true\/b/.test(textOf(r)), textOf(r).slice(0, 40));

r = await call('click', { pageId, uid: btnUid });
check('click button', !r.error, r.error || '');
r = await call('wait_for', { pageId, text: ['CLICKED-NOTE'], timeout: 5000 });
check('  -> click side-effect visible', !r.error, r.error || '');

r = await call('hover', { pageId, uid: btnUid });
check('hover', !r.error, r.error || '');

r = await call('scroll', { pageId, to: 'bottom' });
check('scroll to bottom', !r.error, r.error || '');
r = await call('scroll', { pageId, to: 'top' });
check('scroll to top', !r.error, r.error || '');

r = await call('click_xy', { pageId, x: 50, y: 50 });
check('click_xy', !r.error, r.error || '');

r = await call('evaluate_script', { pageId, function: '() => { document.getElementById("ti").focus(); return "focused"; }' });
check('focus input via eval', !r.error, r.error || '');
r = await call('type_text', { pageId, text: '-typed' });
check('type_text', !r.error, r.error || '');
r = await call('press_key', { pageId, key: 'Control+A' });
check('press_key', !r.error, r.error || '');

r = await call('drag', { pageId, from_uid: dragUid || 'e1', to_uid: dropUid || 'e2' });
check('drag', !r.error, r.error || 'runs');

console.log('== screenshots (before dialogs: open alert blocks renderer) ==');
r = await call('take_screenshot', { pageId, format: 'png' });
const img0 = r.result?.content?.find(c => c.type === 'image');
check('screenshot png', !!img0 && img0.data.length > 1000, img0 ? img0.data.length + ' b64 chars' : (r.error || 'no image'));
r = await call('take_screenshot', { pageId, format: 'jpeg', quality: 50, filePath: OUT + '\\shot.jpg' });
check('screenshot jpeg->file', !r.error, r.error || '');
check('  -> file written', fs.existsSync(OUT + '\\shot.jpg'), fs.existsSync(OUT + '\\shot.jpg') ? fs.statSync(OUT + '\\shot.jpg').size + ' bytes' : 'missing');
r = await call('take_screenshot', { pageId, uid: btnUid, format: 'png' });
const imgEl = r.result?.content?.find(c => c.type === 'image');
check('screenshot element', !!imgEl || !r.error, r.error || 'ok');
r = await call('take_screenshot', { pageId, fullPage: true, format: 'png' });
check('screenshot fullPage', !r.error, r.error || '');

console.log('== cookies / http / upload ==');
r = await call('set_cookie', { pageId, name: 'mcp_test', value: 'cookie42' });
check('set_cookie', !r.error, r.error || '');
r = await call('get_cookies', { pageId });
check('get_cookies sees it', /mcp_test/.test(textOf(r)) && /cookie42/.test(textOf(r)), textOf(r).slice(0, 60));
r = await call('remove_cookie', { pageId, name: 'mcp_test' });
check('remove_cookie', !r.error, r.error || '');
r = await call('get_cookies', { pageId, name: 'mcp_test' });
check('  -> cookie gone', !/cookie42/.test(textOf(r)), 'cleared');

r = await call('http_request', { url: 'https://example.com/', method: 'GET' });
check('http_request GET', /Example Domain/.test(textOf(r)), textOf(r).length + ' chars');

fs.writeFileSync(OUT + '\\upload-me.txt', 'mcp upload test');
r = await call('upload_file', { pageId, uid: fiUid, filePaths: [OUT + '\\upload-me.txt'] });
check('upload_file', !r.error, r.error || '');
r = await call('evaluate_script', { pageId, function: '() => document.getElementById("fi").files.length' });
check('  -> file attached', /1/.test(textOf(r).trim()), textOf(r).slice(0, 40));

console.log('== dialogs ==');
// Debugger already attached by upload_file (DOM domain). Schedule an alert,
// wait for javascriptDialogOpening to land in dialogQueue, then accept.
r = await call('evaluate_script', { pageId, function: '() => { setTimeout(() => alert("mcp-alert"), 200); return "scheduled"; }' });
await sleep(800);
r = await call('handle_dialog', { pageId, action: 'accept' });
check('handle_dialog accept', !r.error, r.error || '');

console.log('== network / console ==');
// Enable capture domains BEFORE the reload so events are recorded.
r = await call('list_network_requests', { pageId });
r = await call('list_console_messages', { pageId });
r = await call('navigate_page', { pageId, type: 'reload' });
check('navigate_page reload', !r.error, r.error || '');
await sleep(1800);
r = await call('evaluate_script', { pageId, function: '() => { console.log("mcp-post-reload-log"); return "logged"; }' });
await sleep(400);
r = await call('list_network_requests', { pageId });
const reqs = jsonOf(r);
const reqList = Array.isArray(reqs) ? reqs : (reqs?.requests || reqs?.items || []);
check('network captured after reload', reqList.length > 0, `${reqList.length} requests`);
if (reqList.length) {
  const rid = reqList[0].reqid ?? reqList[0].id;
  r = await call('get_network_request', { pageId, reqid: rid });
  check('get_network_request', /example\.com|text\/html|200/.test(textOf(r)), textOf(r).slice(0, 80));
} else check('get_network_request', false, 'no reqid');

r = await call('list_console_messages', { pageId });
const msgs = jsonOf(r);
const msgList = Array.isArray(msgs) ? msgs : (msgs?.messages || msgs?.items || []);
const logMsg = msgList.find(m => /mcp-post-reload-log/.test(JSON.stringify(m)));
check('console captured', !!logMsg, `${msgList.length} messages`);
if (logMsg) {
  const mid = logMsg.msgid ?? logMsg.id;
  r = await call('get_console_message', { pageId, msgid: mid });
  check('get_console_message', !r.error, textOf(r).slice(0, 80));
} else check('get_console_message', false, 'no msgid');

console.log('== emulation / perf / heap / pdf ==');
r = await call('emulate', { pageId, colorScheme: 'dark' });
check('emulate dark mode', !r.error, r.error || '');
r = await call('emulate', { pageId, colorScheme: 'light' });
check('emulate revert', !r.error, r.error || '');
r = await call('emulate', { pageId, viewport: '390x844x3,mobile,touch' });
check('emulate mobile viewport', !r.error, r.error || '');
r = await call('emulate', { pageId, viewport: '' });
check('emulate clear viewport', !r.error, r.error || '');

r = await call('performance_start_trace', { pageId });
check('perf start', !r.error, r.error || '');
await sleep(1200);
r = await call('performance_stop_trace', { pageId, filePath: OUT + '\\trace.json' });
check('perf stop + trace file', !r.error && fs.existsSync(OUT + '\\trace.json'), r.error || 'trace.json written');

// take_heapsnapshot removed: chrome.debugger doesn't expose HeapProfiler.

r = await call('save_pdf', { pageId, filePath: OUT + '\\page.pdf' });
check('save_pdf', !r.error && fs.existsSync(OUT + '\\page.pdf'), r.error || (fs.existsSync(OUT + '\\page.pdf') ? fs.statSync(OUT + '\\page.pdf').size + ' bytes' : 'missing'));

console.log('== downloads ==');
r = await call('download_file', { url: 'https://example.com/', filename: 'mcp-dl-test.html', conflictAction: 'uniquify' });
check('download_file', !r.error, (r.error || textOf(r).slice(0, 80)));
r = await call('list_downloads', { limit: 5 });
check('list_downloads', /mcp-dl-test|filename|state/.test(textOf(r)), textOf(r).slice(0, 80));

console.log('== navigation / resize / stale-uid ==');
// tabs.update REPLACES history entries instead of pushing (Chrome semantics) —
// build real history by clicking the "Learn more" link instead.
r = await call('navigate_page', { pageId, type: 'url', url: 'https://example.com/' });
await sleep(1200);
r = await call('take_snapshot', { pageId });
const lmUid = uidOf(r, /Learn more/i);
r = await call('click', { pageId, uid: lmUid });
check('navigate via link click', !r.error, r.error || '');
await sleep(5000);
r = await call('evaluate_script', { pageId, function: '() => location.href' });
check('  -> link navigation happened', !/example\.com\/?$/.test((jsonOf(r)?.result || '')), jsonOf(r)?.result || '');
r = await call('navigate_page', { pageId, type: 'back' });
check('navigate back', !r.error, r.error || '');
await sleep(1200);
r = await call('evaluate_script', { pageId, function: '() => location.href' });
check('  -> back to example.com', /example\.com/.test(jsonOf(r)?.result || ''), jsonOf(r)?.result || '');
r = await call('navigate_page', { pageId, type: 'forward' });
check('navigate forward', !r.error, r.error || '');
await sleep(1200);

r = await call('resize_page', { pageId, width: 900, height: 700 });
check('resize_page', !r.error, r.error || '');

r = await call('click', { pageId, uid: btnUid });
check('stale uid after navigation -> error', !!r.error && /stale|not found|no element|uid/i.test(r.error), r.error || 'unexpectedly succeeded');

console.log('== incognito context ==');
r = await call('new_page', { url: 'https://example.com/', isolatedContext: 'test' });
const isoId = jsonOf(r)?.pageId;
if (r.error && /incognito/i.test(r.error)) {
  expectLimited('new_page isolatedContext', r, 'needs "Allow in incognito" toggle in chrome://extensions');
} else {
  check('new_page isolatedContext', !r.error && Number.isInteger(isoId), r.error || 'pageId=' + isoId);
  if (Number.isInteger(isoId)) await call('close_page', { pageId: isoId });
}

console.log('== teardown ==');
r = await call('detach_debugger', { pageId });
check('detach_debugger', !r.error, r.error || '');
r = await call('close_page', { pageId });
check('close_page', !r.error, r.error || '');

console.log(`\n======== RESULT: ${pass} passed, ${fail} failed, ${xfail} known-limitation ========`);
if (fails.length) console.log('failed:', fails.join(', '));
