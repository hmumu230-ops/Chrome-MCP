import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/forms.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID });
const uidOf = async (id) => await evl(PID, `() => document.getElementById('${id}').getAttribute('data-mcp-uid')`);
const [t, ta, cb] = await Promise.all([uidOf('t-text'), uidOf('ta'), uidOf('cb')]);
const r = await call('fill_form', { pageId: PID, elements: [{ uid: t, value: 'batch1' }, { uid: ta, value: 'batchTA' }, { uid: cb, value: 'true' }] });
const v = await evl(PID, `() => ({t: document.getElementById('t-text').value, ta: document.getElementById('ta').value, cb: document.getElementById('cb').checked})`);
ok('fill_form batch', !r.isError && v.t === 'batch1' && v.ta === 'batchTA' && v.cb === true, `resp=${r.text.slice(0, 150)} vals=${JSON.stringify(v)}`);

// scroll tool: to bottom, by dy, to uid
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/grid.html' });
await new Promise(s => setTimeout(s, 800));
await call('take_snapshot', { pageId: PID });
let y0 = await evl(PID, '() => scrollY');
await call('scroll', { pageId: PID, to: 'bottom' });
let y1 = await evl(PID, '() => scrollY');
ok('scroll to bottom', y1 > 800, `y ${y0} -> ${y1}`);
await call('scroll', { pageId: PID, to: 'top' });
let y2 = await evl(PID, '() => scrollY');
ok('scroll to top', y2 === 0, `y=${y2}`);
await call('scroll', { pageId: PID, dy: 500 });
let y3 = await evl(PID, '() => scrollY');
ok('scroll dy=500', Math.abs(y3 - 500) < 60, `y=${y3}`);
const pbUid = await evl(PID, `() => document.getElementById('page-bottom').getAttribute('data-mcp-uid')`);
await call('scroll', { pageId: PID, dy: -500 });
await call('scroll', { pageId: PID, uid: pbUid });
let y4 = await evl(PID, '() => scrollY');
let inView = await evl(PID, `() => { const r = document.getElementById('page-bottom').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }`);
ok('scroll to uid', inView === true, `y=${y4} inView=${inView}`);

// scroll INSIDE the container via dx/dy? (page-level only) — verify scroller scrollTop via uid scroll
const scUid = await evl(PID, `() => document.getElementById('scrolled-btn').getAttribute('data-mcp-uid')`);
await call('scroll', { pageId: PID, uid: scUid });
const st = await evl(PID, `() => document.getElementById('scroller').scrollTop`);
ok('scroll uid scrolls container', st > 200, `scroller.scrollTop=${st}`);
process.exit(0);
