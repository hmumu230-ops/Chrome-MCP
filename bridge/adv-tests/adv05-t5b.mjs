import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID });
const kUid = await evl(PID, `() => document.getElementById('kinput').getAttribute('data-mcp-uid')`);
await call('fill', { pageId: PID, uid: kUid, value: 'ABCDEFGH' });
// caret to end
await evl(PID, `() => { const el = document.getElementById('kinput'); el.focus(); el.setSelectionRange(8, 8); return 'ok'; }`);
await call('press_key', { pageId: PID, key: 'ArrowLeft' });
let s = await evl(PID, `() => { const el = document.getElementById('kinput'); return el.selectionStart + '-' + el.selectionEnd; }`);
ok('CDP ArrowLeft caret 8->7', s === '7-7', `sel=${s}`);
// Enter with input focused: check keylog + keyCode
await evl(PID, '() => (window.keylog.length = 0, document.getElementById("kinput").focus(), "ok")');
await call('press_key', { pageId: PID, key: 'Enter' });
let l = await evl(PID, '() => window.keylog.slice()');
const ent = l && l.find ? l.find(e => e.k === 'Enter' && e.t === 'keydown') : null;
ok('CDP Enter on input kc=13', ent && ent.kc === 13, `ent=${JSON.stringify(ent)}`);
// Escape kc=27
await call('press_key', { pageId: PID, key: 'Escape' });
l = await evl(PID, '() => window.keylog.slice()');
const esc = l && l.find ? l.filter(e => e.k === 'Escape').at(-1) : null;
ok('CDP Escape kc=27', esc && esc.kc === 27, `esc=${JSON.stringify(esc)}`);
// Ctrl+C / Ctrl+V roundtrip: select all + copy, clear, paste
await call('fill', { pageId: PID, uid: kUid, value: 'CLIP42' });
await evl(PID, `() => { const el = document.getElementById('kinput'); el.focus(); el.setSelectionRange(0, 6); return 'ok'; }`);
await call('press_key', { pageId: PID, key: 'Control+C' });
await call('fill', { pageId: PID, uid: kUid, value: '' });
await evl(PID, `() => { document.getElementById('kinput').focus(); return 'ok'; }`);
await call('press_key', { pageId: PID, key: 'Control+V' });
const pv = await evl(PID, `() => document.getElementById('kinput').value`);
ok('CDP Ctrl+C/V roundtrip', pv === 'CLIP42', `pasted=${JSON.stringify(pv)}`);
// hover check while debugger attached (still synthetic — hover has no CDP path)
const hovUid = await evl(PID, `() => document.getElementById('hov').getAttribute('data-mcp-uid')`);
await evl(PID, '() => (window.hovers.length = 0, "ok")');
await call('hover', { pageId: PID, uid: hovUid });
const hv = await evl(PID, `() => ({evts: window.hovers.slice(), hoverPseud: document.getElementById('hov').matches(':hover')})`);
ok('hover events + :hover', hv.evts.length > 0, `evts=${JSON.stringify(hv.evts)} :hover=${hv.hoverPseud}`);
process.exit(0);
