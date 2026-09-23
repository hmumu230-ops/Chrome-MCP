import { init, call, ok, evl } from './adv05-lib.mjs';
await init();
const PID = Number(process.argv[2]);
await call('navigate_page', { pageId: PID, type: 'url', url: 'http://127.0.0.1:8123/grid.html' });
await new Promise(r => setTimeout(r, 900));
await call('take_snapshot', { pageId: PID });

// click_xy over iframe button → elementFromPoint returns <iframe>, inner button unaffected
const fr = await evl(PID, `() => { const r = document.getElementById('fr').getBoundingClientRect(); return {l:r.left,t:r.top}; }`);
const x = Math.round(fr.l + 60), y = Math.round(fr.t + 15);
await evl(PID, '() => (window.clicks.length = 0, document.getElementById("fr").contentWindow.frameClicks.length = 0, "ok")');
await call('click_xy', { pageId: PID, x, y });
const main = await evl(PID, '() => window.clicks.at(-1) || null');
const inner = await evl(PID, '() => document.getElementById("fr").contentWindow.frameClicks.at(-1) || null');
ok('click_xy over iframe', main && main.id === 'fr' && !inner, `main=${JSON.stringify(main)} inner=${JSON.stringify(inner)} (iframe content unreachable by xy)`);

// occluded element: click uid on a button covered by another element — synthetic dispatch still fires on it
await evl(PID, `() => { const oc = document.createElement('div'); oc.id='occl'; oc.style.cssText='position:fixed;top:0;left:0;width:200px;height:60px;background:rgba(255,0,0,.5);z-index:99'; document.body.appendChild(oc); return 'ok'; }`);
await call('take_snapshot', { pageId: PID });
const g00 = await evl(PID, `() => document.getElementById('g-0-0').getAttribute('data-mcp-uid')`);
await evl(PID, '() => (window.clicks.length = 0, "ok")');
await call('click', { pageId: PID, uid: g00 });
const c = await evl(PID, '() => window.clicks.at(-1) || null');
ok('uid click occluded el', c && c.id === 'g-0-0', `last=${JSON.stringify(c)} (synthetic dispatch ignores occlusion)`);
const xy = await call('click_xy', { pageId: PID, x: 19, y: 13 });
const c2 = await evl(PID, '() => window.clicks.at(-1) || null');
ok('click_xy occluded hits top', c2 && c2.id === 'occl', `last=${JSON.stringify(c2)} resp=${xy.text.slice(0, 120)}`);

// link click navigation
await evl(PID, `() => { const a = document.createElement('a'); a.id='navlink'; a.href='/frame.html'; a.textContent='GOTO FRAME'; a.style.cssText='position:fixed;top:300px;left:500px;z-index:100'; document.body.appendChild(a); return 'ok'; }`);
await call('take_snapshot', { pageId: PID });
const linkUid = await evl(PID, `() => document.getElementById('navlink').getAttribute('data-mcp-uid')`);
const before = await evl(PID, '() => location.pathname');
await call('click', { pageId: PID, uid: linkUid });
await new Promise(s => setTimeout(s, 1200));
const after = await evl(PID, '() => location.pathname');
ok('link click navigates', before === '/grid.html' && after === '/frame.html', `${before} -> ${after}`);
process.exit(0);
