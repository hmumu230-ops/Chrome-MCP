import { init, call, ok, evl } from './adv05-lib.mjs';
await init();

const PID = Number(process.argv[2] || 0);
if (!PID) { console.log('need PID'); process.exit(1); }
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/grid.html' });
await new Promise(r => setTimeout(r, 1000));

const snap = await call('take_snapshot', { pageId: PID });
let snapObj; try { snapObj = JSON.parse(snap.text); } catch { snapObj = {}; }
const lines = snapObj.lines || [];
const uidByName = {};
for (const l of lines) {
  const m = l.match(/\[([^\]]+)\]\s+(\w+)\s+"([^"]*)"/);
  if (m) uidByName[m[3]] = m[1];
}
console.log('uid count:', Object.keys(uidByName).length);

async function lastClick() {
  const v = await evl(PID, '() => window.clicks.at(-1) || null');
  return v && v.__err ? null : v;
}
async function rectOf(expr) {
  return await evl(PID, `() => { const el = ${expr}; if(!el) return null; const r = el.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}; }`);
}
async function clearClicks() { await evl(PID, '() => (window.clicks.length = 0, "ok")'); }

async function clickAndCheck(name, uid, expectId, rectExpr) {
  await clearClicks();
  const cr = await call('click', { pageId: PID, uid });
  if (cr.isError) return ok(`click ${name}`, false, 'tool error: ' + cr.text.slice(0, 150));
  const c = await lastClick();
  const rect = rectExpr ? await rectOf(rectExpr) : null;
  const idHit = c && c.id === expectId;
  const inRect = rect && c ? (c.x >= rect.l - 1 && c.x <= rect.r + 1 && c.y >= rect.t - 1 && c.y <= rect.b + 1) : null;
  ok(`click ${name}`, !!(idHit && (inRect === null || inRect)), `last=${JSON.stringify(c)} rect=${JSON.stringify(rect)}`);
}

await clickAndCheck('grid g-1-3', uidByName['1,3'], 'g-1-3', `document.getElementById('g-1-3')`);
await clickAndCheck('grid g-2-5', uidByName['2,5'], 'g-2-5', `document.getElementById('g-2-5')`);
await clickAndCheck('grid g-0-0', uidByName['0,0'], 'g-0-0', `document.getElementById('g-0-0')`);
await clickAndCheck('grid g-3-9', uidByName['3,9'], 'g-3-9', `document.getElementById('g-3-9')`);
await clickAndCheck('edge TL', uidByName['TL'], 'edge-tl', `document.getElementById('edge-tl')`);
await clickAndCheck('edge BR', uidByName['BR'], 'edge-br', `document.getElementById('edge-br')`);
await clickAndCheck('edge MR', uidByName['MR'], 'edge-midright', `document.getElementById('edge-midright')`);
await clickAndCheck('scrolled-btn', uidByName['DEEP IN SCROLLER'], 'scrolled-btn', `document.getElementById('scrolled-btn')`);
await clickAndCheck('fixed-btn', uidByName['FIXED'], 'fixed-btn', `document.getElementById('fixed-btn')`);

// iframe via frame-scoped uid
{
  const uid = uidByName['IFRAME-BTN'];
  await evl(PID, '() => (document.getElementById("fr").contentWindow.frameClicks.length = 0, "ok")');
  const cr = await call('click', { pageId: PID, uid });
  const c = await evl(PID, '() => document.getElementById("fr").contentWindow.frameClicks.at(-1) || null');
  ok('click iframe-btn', !cr.isError && c && c.id === 'frame-btn', `err=${cr.isError} uid=${uid} last=${JSON.stringify(c)}`);
}

await clickAndCheck('far-below(scroll)', uidByName['FAR BELOW (needs page scroll)'], 'page-bottom', `document.getElementById('page-bottom')`);

await evl(PID, '() => (window.scrollTo(0,0), document.getElementById("scroller").scrollTop = 0, "ok")');

// open shadow via click_xy
{
  const rect = await rectOf(`document.getElementById('shadow-open-host').shadowRoot.getElementById('sh-open-btn')`);
  const x = Math.round(rect.l + rect.w / 2), y = Math.round(rect.t + rect.h / 2);
  await clearClicks();
  await call('click_xy', { pageId: PID, x, y });
  const c = await lastClick();
  ok('click_xy open-shadow-btn', c && c.id === 'sh-open-btn', `xy=${x},${y} last=${JSON.stringify(c)} rect=${JSON.stringify(rect)}`);
}
// closed shadow via click_xy
{
  const rect = await rectOf(`document.getElementById('shadow-closed-host')`);
  const x = Math.round(rect.l + 60), y = Math.round(rect.t + 15);
  await clearClicks();
  await call('click_xy', { pageId: PID, x, y });
  const c = await lastClick();
  ok('click_xy closed-shadow-btn', c && c.id === 'sh-closed-btn', `xy=${x},${y} last=${JSON.stringify(c)} hostRect=${JSON.stringify(rect)}`);
}
// neighbor exclusion via click_xy center of g-0-5
{
  const r5 = await rectOf(`document.getElementById('g-0-5')`);
  const x = Math.round(r5.l + r5.w / 2), y = Math.round(r5.t + r5.h / 2);
  await clearClicks();
  await call('click_xy', { pageId: PID, x, y });
  const c = await lastClick();
  ok('click_xy grid g-0-5 center', c && c.id === 'g-0-5', `xy=${x},${y} last=${JSON.stringify(c)}`);
}
// edge pixel: click_xy at (2,2) should hit edge-tl
{
  await clearClicks();
  await call('click_xy', { pageId: PID, x: 3, y: 3 });
  const c = await lastClick();
  ok('click_xy viewport corner (3,3)', c && c.id === 'edge-tl', `last=${JSON.stringify(c)}`);
}
process.exit(0);
