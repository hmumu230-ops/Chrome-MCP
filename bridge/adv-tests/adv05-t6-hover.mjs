import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID });
const hovUid = await evl(PID, `() => document.getElementById('hov').getAttribute('data-mcp-uid')`);
console.log('hov uid:', hovUid);

// hover (synthetic — no CDP path exists for hover)
await evl(PID, '() => (window.hovers.length = 0, "ok")');
let r = await call('hover', { pageId: PID, uid: hovUid });
const hv = await evl(PID, `() => ({evts: window.hovers.slice(), pseud: document.getElementById('hov').matches(':hover')})`);
ok('hover mouseover/move fire', !r.isError && hv.evts.includes('over') && hv.evts.includes('move'), `err=${r.isError} evts=${JSON.stringify(hv.evts)} :hover=${hv.pseud} (mouseenter+natives :hover absent by design)`);

// dblClick via uid
await evl(PID, '() => (window.dbls.length = 0, "ok")');
r = await call('click', { pageId: PID, uid: hovUid, dblClick: true });
const d = await evl(PID, `() => window.dbls.slice()`);
ok('dblClick fires dblclick', !r.isError && d.includes('hov'), `err=${r.isError} dbls=${JSON.stringify(d)}`);

// link click navigation (synthetic el.click on <a> — does it navigate?)
process.exit(0);
