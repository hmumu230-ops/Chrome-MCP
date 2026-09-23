import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 800));
await call('select_page', { pageId: PID, bringToFront: true });
await call('take_snapshot', { pageId: PID, verbose: true }); // attaches debugger
const st = await evl(PID, `() => ({vis: document.visibilityState, focus: document.hasFocus()})`);
console.log('state:', JSON.stringify(st));

await call('take_snapshot', { pageId: PID });
const kUid = await evl(PID, `() => document.getElementById('kinput').getAttribute('data-mcp-uid')`);
await call('fill', { pageId: PID, uid: kUid, value: 'ABCDEFGH' });
await evl(PID, `() => { const el = document.getElementById('kinput'); el.focus(); el.setSelectionRange(8, 8); window.keylog.length = 0; return 'ok'; }`);

// 1) ArrowLeft caret move (needs rawKeyDown for default action?)
await call('press_key', { pageId: PID, key: 'ArrowLeft' });
let s = await evl(PID, `() => { const el = document.getElementById('kinput'); return el.selectionStart + '-' + el.selectionEnd; }`);
let l = await evl(PID, '() => window.keylog.slice()');
const arr = l && l.find ? l.find(e => e.k === 'ArrowLeft' && e.t === 'keydown') : null;
ok('CDP ArrowLeft', s === '7-7', `sel=${s} evt=${JSON.stringify(arr)}`);

// 2) Enter on focused input — real keyCode?
await evl(PID, '() => (window.keylog.length = 0, document.getElementById("kinput").focus(), "ok")');
await call('press_key', { pageId: PID, key: 'Enter' });
l = await evl(PID, '() => window.keylog.slice()');
const ent = l && l.find ? l.find(e => e.k === 'Enter' && e.t === 'keydown') : null;
ok('CDP Enter kc=13', ent && ent.kc === 13, `ent=${JSON.stringify(ent)}`);

// 3) clipboard roundtrip
await call('fill', { pageId: PID, uid: kUid, value: 'CLIP42' });
await evl(PID, `() => { const el = document.getElementById('kinput'); el.focus(); el.setSelectionRange(0, 6); return 'ok'; }`);
await call('press_key', { pageId: PID, key: 'Control+C' });
await call('fill', { pageId: PID, uid: kUid, value: '' });
await evl(PID, `() => { document.getElementById('kinput').focus(); return 'ok'; }`);
await call('press_key', { pageId: PID, key: 'Control+V' });
const pv = await evl(PID, `() => document.getElementById('kinput').value`);
ok('CDP Ctrl+C/V', pv === 'CLIP42', `pasted=${JSON.stringify(pv)}`);

// 4) hover — always synthetic; verify events
const hovUid = await evl(PID, `() => document.getElementById('hov').getAttribute('data-mcp-uid')`);
await evl(PID, '() => (window.hovers.length = 0, "ok")');
const hr = await call('hover', { pageId: PID, uid: hovUid });
const hv = await evl(PID, `() => ({evts: window.hovers.slice(), pseud: document.getElementById('hov').matches(':hover')})`);
ok('hover events fire', !hr.isError && hv.evts.length >= 2, `err=${hr.isError} evts=${JSON.stringify(hv.evts)} :hover=${hv.pseud}`);

// 5) upload_file — real CDP DOM.setFileInputFiles
const f1 = await evl(PID, `() => document.getElementById('f1').getAttribute('data-mcp-uid')`);
const f2 = await evl(PID, `() => document.getElementById('f2').getAttribute('data-mcp-uid')`);
await evl(PID, '() => (window.uploads.length = 0, "ok")');
let ur = await call('upload_file', { pageId: PID, uid: f1, filePaths: ['D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv05-up1.txt'] });
let up = await evl(PID, `() => ({u: window.uploads.slice(), n: document.getElementById('f1').files.length, nm: document.getElementById('f1').files[0] && document.getElementById('f1').files[0].name})`);
ok('upload single', !ur.isError && up.n === 1 && up.nm === 'adv05-up1.txt', `err=${ur.isError} ${JSON.stringify(up)}`);
ur = await call('upload_file', { pageId: PID, uid: f2, filePaths: ['D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv05-up1.txt', 'D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\adv05-up2.txt'] });
up = await evl(PID, `() => ({u: window.uploads.slice(), n: document.getElementById('f2').files.length, nm: [...document.getElementById('f2').files].map(f => f.name)})`);
ok('upload multiple', !ur.isError && up.n === 2 && up.nm.includes('adv05-up2.txt'), `err=${ur.isError} ${JSON.stringify(up)}`);
// upload nonexistent file → bridge stats first
ur = await call('upload_file', { pageId: PID, uid: f1, filePaths: ['D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\no-such.txt'] });
ok('upload missing file rejected', ur.isError && /does not exist/i.test(ur.text), `resp=${ur.text.slice(0, 120)}`);
process.exit(0);
