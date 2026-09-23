import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID });
const kUid = await evl(PID, `() => document.getElementById('kinput').getAttribute('data-mcp-uid')`);
console.log('kinput uid:', kUid);

// focus the input via fill (el.focus())
await call('fill', { pageId: PID, uid: kUid, value: '' });
const focused = await evl(PID, `() => document.activeElement.id`);
console.log('activeElement:', focused);

const clearLog = () => evl(PID, '() => (window.keylog.length = 0, "ok")');
const getLog = () => evl(PID, '() => window.keylog.slice()');

async function pressAndCheck(name, key, checkFn) {
  await clearLog();
  const r = await call('press_key', { pageId: PID, key });
  const l = await getLog();
  const extra = await checkFn(l);
  ok(`press_key ${name}`, !r.isError && extra.ok, `err=${r.isError} ${extra.ev || ''} log=${JSON.stringify(l).slice(0, 220)}`);
}

await pressAndCheck('Enter', 'Enter', l => ({ ok: l.some(e => e.t === 'keydown' && e.k === 'Enter') && l.some(e => e.t === 'keyup'), ev: `kc=${l[0] && l[0].kc} code=${l[0] && l[0].c}` }));
await pressAndCheck('Escape', 'Escape', l => ({ ok: l.some(e => e.k === 'Escape'), ev: `kc=${l[0] && l[0].kc}` }));
await pressAndCheck('Tab', 'Tab', async l => ({ ok: l.some(e => e.k === 'Tab'), ev: `kc=${l[0] && l[0].kc}` }));
// did Tab move focus? (synthetic shouldn't)
const afterTab = await evl(PID, `() => document.activeElement.id`);
ok('Tab moved focus?', afterTab !== 'kinput', `activeElement=${afterTab}`);
await pressAndCheck('ArrowDown', 'ArrowDown', l => ({ ok: l.some(e => e.k === 'ArrowDown'), ev: `kc=${l[0] && l[0].kc} code=${l[0] && l[0].c}` }));
await pressAndCheck('F5', 'F5', l => ({ ok: l.some(e => e.k === 'F5'), ev: `kc=${l[0] && l[0].kc}` }));

// Ctrl+A → should select input content (synthetic won't)
await call('fill', { pageId: PID, uid: kUid, value: 'SELECTME' });
await clearLog();
let r = await call('press_key', { pageId: PID, key: 'Control+A' });
let l = await getLog();
const sel = await evl(PID, `() => { const el = document.getElementById('kinput'); return el.selectionStart + '-' + el.selectionEnd; }`);
ok('Ctrl+A selects', sel === '0-8', `sel=${sel} evt=${JSON.stringify(l.filter(e => e.t === 'keydown'))}`);

// Ctrl+V paste — synthetic can't paste; set clipboard? can't. Check value unchanged.
await call('fill', { pageId: PID, uid: kUid, value: 'X' });
r = await call('press_key', { pageId: PID, key: 'Control+V' });
const vv = await evl(PID, `() => document.getElementById('kinput').value`);
ok('Ctrl+V paste', vv !== 'X', `value=${JSON.stringify(vv)} (clipboard empty anyway — observing no-crash)`);

// type_text into focused input
await call('fill', { pageId: PID, uid: kUid, value: '' });
await clearLog();
r = await call('type_text', { pageId: PID, text: 'Hi7' });
const tv = await evl(PID, `() => document.getElementById('kinput').value`);
l = await getLog();
const kd = l.filter(e => e.t === 'keydown').map(e => e.k);
const inp = l.filter(e => e.t === 'input').length;
ok('type_text value', tv === 'Hi7', `value=${JSON.stringify(tv)} keydowns=${JSON.stringify(kd)} inputEvents=${inp}`);

// type_text with submitKey
await clearLog();
r = await call('type_text', { pageId: PID, text: 'zz', submitKey: 'Enter' });
l = await getLog();
ok('type_text+submitKey', l.some(e => e.k === 'Enter' && e.t === 'keydown'), `log=${JSON.stringify(l).slice(0, 200)}`);

// maxlength + type_text (execCommand path should respect maxlength)
const maxUid = await evl(PID, `() => document.getElementById('t-max').getAttribute('data-mcp-uid')`);
await call('fill', { pageId: PID, uid: maxUid, value: '' });
await call('type_text', { pageId: PID, text: '123456789' });
const mv = await evl(PID, `() => document.getElementById('t-max').value`);
ok('type_text respects maxlength', mv === '12345', `value=${JSON.stringify(mv)}`);

// press_key with nothing focused
await evl(PID, '() => (document.activeElement.blur(), document.body.focus ? null : null, "ok")');
await evl(PID, '() => (document.activeElement && document.activeElement.blur && document.activeElement.blur(), "ok")');
r = await call('press_key', { pageId: PID, key: 'Enter' });
ok('press_key unfocused page', true, `err=${r.isError} resp=${r.text.slice(0, 120)}`);
process.exit(0);
