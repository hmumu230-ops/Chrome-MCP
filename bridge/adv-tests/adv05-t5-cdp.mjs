import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);

// make tab active + attach debugger (verbose snapshot attaches CDP)
await call('select_page', { pageId: PID, bringToFront: true });
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));
const vs = await call('take_snapshot', { pageId: PID, verbose: true });
console.log('verbose snapshot err?', vs.isError, vs.text.slice(0, 120));
const act = await evl(PID, `() => ({vis: document.visibilityState, focus: document.hasFocus()})`);
console.log('visibility:', JSON.stringify(act));

await call('take_snapshot', { pageId: PID });
const kUid = await evl(PID, `() => document.getElementById('kinput').getAttribute('data-mcp-uid')`);
await call('fill', { pageId: PID, uid: kUid, value: '' });
const clearLog = () => evl(PID, '() => (window.keylog.length = 0, "ok")');
const getLog = () => evl(PID, '() => window.keylog.slice()');

// CDP click on a grid button? we're on forms page — test click on checkbox uid (trusted → real toggle)
const cbUid = await evl(PID, `() => document.getElementById('cb').getAttribute('data-mcp-uid')`);
await evl(PID, `() => (document.getElementById('cb').checked = false)`);
await evl(PID, '() => (window.formClicks.length = 0, "ok")');
let r = await call('click', { pageId: PID, uid: cbUid });
const cc = await evl(PID, `() => window.formClicks.at(-1)`);
const chk = await evl(PID, `() => document.getElementById('cb').checked`);
ok('CDP click checkbox trusted', chk === true && cc && cc.trusted === true && cc.x > 0, `checked=${chk} last=${JSON.stringify(cc)} resp=${r.text.slice(0, 80)}`);

// CDP press_key Enter
await clearLog();
r = await call('press_key', { pageId: PID, key: 'Enter' });
let l = await getLog();
const ent = l.find(e => e.k === 'Enter' && e.t === 'keydown');
ok('CDP Enter kc=13 trusted', ent && ent.kc === 13, `kc=${ent && ent.kc} code=${ent && ent.c} resp=${r.text.slice(0, 80)}`);

// CDP Tab → focus moves?
r = await call('press_key', { pageId: PID, key: 'Tab' });
l = await getLog();
const tab = l.find(e => e.k === 'Tab' && e.t === 'keydown');
const afterTab = await evl(PID, `() => document.activeElement.id + '/' + document.activeElement.tagName`);
ok('CDP Tab kc=9 + focus moves', tab && tab.kc === 9 && afterTab !== 'kinput/INPUT', `kc=${tab && tab.kc} now=${afterTab}`);

// CDP Ctrl+A on filled input → selection
await call('fill', { pageId: PID, uid: kUid, value: 'SELECTME' });
await clearLog();
r = await call('press_key', { pageId: PID, key: 'Control+A' });
const sel = await evl(PID, `() => { const el = document.getElementById('kinput'); return el.selectionStart + '-' + el.selectionEnd; }`);
l = await getLog();
ok('CDP Ctrl+A selects', sel === '0-8', `sel=${sel} evt=${JSON.stringify(l.filter(e => e.t === 'keydown'))}`);

// CDP arrows move caret
await call('press_key', { pageId: PID, key: 'ArrowLeft' });
const caret = await evl(PID, `() => document.getElementById('kinput').selectionStart`);
ok('CDP ArrowLeft moves caret', caret === 7, `caret=${caret}`);

// CDP typing a char via press_key 'q' inserts into input
await clearLog();
r = await call('press_key', { pageId: PID, key: 'q' });
const qv = await evl(PID, `() => document.getElementById('kinput').value`);
l = await getLog();
ok('CDP key q inserts', qv === 'SELECTMq' || qv.includes('q'), `val=${JSON.stringify(qv)} resp=${r.text.slice(0, 80)}`);

// F5 → real reload? mark via sessionStorage then check navigation type
await evl(PID, `() => (sessionStorage.setItem('f5','seen'), "ok")`);
r = await call('press_key', { pageId: PID, key: 'F5' });
await new Promise(s => setTimeout(s, 1500));
const nav = await evl(PID, `() => ({t: (performance.getEntriesByType('navigation')[0] || {}).type, f5: sessionStorage.getItem('f5')})`);
ok('CDP F5 reloads page', nav && nav.t === 'reload' && nav.f5 === 'seen', `nav=${JSON.stringify(nav)}`);
process.exit(0);
