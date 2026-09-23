import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/drag.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID }); // assigns data-mcp-uid attrs
const uidOf = async (id) => await evl(PID, `() => { const el = document.getElementById('${id}'); return el ? el.getAttribute('data-mcp-uid') : null; }`);
const srcUid = await uidOf('src'), dstUid = await uidOf('dst'), mdUid = await uidOf('mdrag'), thUid = await uidOf('mthumb'), rngUid = await uidOf('rng');
console.log('uids:', JSON.stringify({ srcUid, dstUid, mdUid, thUid, rngUid }));

const log = async () => await evl(PID, '() => window.draglog.slice()');

// 1) HTML5 drag
await evl(PID, '() => (window.draglog.length = 0, "ok")');
{
  const r = await call('drag', { pageId: PID, from_uid: srcUid, to_uid: dstUid });
  const l = await log();
  const hasStart = l.includes('dragstart'), hasDrop = l.some(x => x.startsWith('drop')), dataOk = l.some(x => x.includes('data=payload'));
  ok('html5 drag', !r.isError && hasStart && hasDrop && dataOk, `err=${r.isError} log=${JSON.stringify(l)}`);
}
// 2) mouse-based drag (mousedown/mousemove/mouseup impl)
{
  await evl(PID, '() => (window.draglog.length = 0, "ok")');
  const r = await call('drag', { pageId: PID, from_uid: mdUid, to_uid: dstUid });
  const l = await log();
  const pos = await evl(PID, `() => ({l:document.getElementById('mdrag').style.left, t:document.getElementById('mdrag').style.top})`);
  const moved = pos.l !== '' && pos.l !== '0px';
  ok('mouse-drag box', moved, `err=${r.isError} log=${JSON.stringify(l)} pos=${JSON.stringify(pos)}`);
}
// 3) thumb slider via drag
{
  await evl(PID, '() => (window.draglog.length = 0, "ok")');
  const r = await call('drag', { pageId: PID, from_uid: thUid, to_uid: dstUid });
  const l = await log();
  const left = await evl(PID, `() => document.getElementById('mthumb').style.left`);
  ok('thumb slider drag', left && left !== '0px', `err=${r.isError} log=${JSON.stringify(l)} thumbLeft=${JSON.stringify(left)}`);
}
// 4) range: click_xy at 75%
{
  const rect = await evl(PID, `() => { const r = document.getElementById('rng').getBoundingClientRect(); return {l:r.left,t:r.top,w:r.width,h:r.height}; }`);
  const x = Math.round(rect.l + rect.w * 0.75), y = Math.round(rect.t + rect.h / 2);
  await evl(PID, '() => (window.draglog.length = 0, "ok")');
  const hit = await evl(PID, `() => document.elementFromPoint(${x},${y}).id`);
  await call('click_xy', { pageId: PID, x, y });
  const v = await evl(PID, `() => document.getElementById('rng').value`);
  const l = await log();
  ok('range click_xy@75%', Number(v) >= 70 && Number(v) <= 80, `hit=${hit} val=${v} log=${JSON.stringify(l)} xy=${x},${y}`);
}
// 5) range: uid click
{
  await evl(PID, `() => (document.getElementById('rng').value = 0, "ok")`);
  const r = await call('click', { pageId: PID, uid: rngUid });
  const v = await evl(PID, `() => document.getElementById('rng').value`);
  ok('range uid-click', true, `err=${r.isError} val=${v}`);
}
// 6) range via fill (setter path)
{
  const r = await call('fill', { pageId: PID, uid: rngUid, value: '75' });
  const v = await evl(PID, `() => document.getElementById('rng').value`);
  ok('range fill=75', !r.isError && v === '75', `err=${r.isError} val=${v}`);
}
process.exit(0);
