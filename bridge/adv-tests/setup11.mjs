// adv11 setup: create a tab, build the screenshot test DOM, snapshot, report uids.
const BASE = 'http://127.0.0.1:7890/mcp';
let sid = null;
async function req(method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  for (let att = 0; att < 8; att++) {
    const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.status === 503) { await new Promise(r => setTimeout(r, 1500)); continue; }
    if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
    const t = await res.text();
    const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
    try { return { status: res.status, body: JSON.parse(dataLine || t) }; } catch { return { status: res.status, body: t }; }
  }
  return { status: 503, body: 'session retry exhausted' };
}
function txt(r) {
  const c = r && r.body && r.body.result && r.body.result.content;
  if (!c) return JSON.stringify(r.body).slice(0, 500);
  return c.map(x => x.text || `[${x.type}]`).join('\n');
}
async function call(tool, args, id) {
  const t0 = Date.now();
  const r = await req('tools/call', { name: tool, arguments: args }, id);
  return { status: r.status, elapsed: Date.now() - t0, text: txt(r), body: r.body };
}

await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv11-setup', version: '0' } });

// 1. create foreground tab on example.com
const np = await call('new_page', { url: 'https://example.com/' }, 2);
console.log('NEW_PAGE', np.elapsed + 'ms', np.text.slice(0, 200));
const m = np.text.match(/"pageId":\s*(\d+)/);
const pageId = m && Number(m[1]);
if (!pageId) { console.log('NO PAGEID'); process.exit(1); }

// 2. build the DOM via evaluate_script (MAIN world)
const buildSrc = `() => {
  const d = document;
  d.documentElement.style.margin = '0';
  d.body.style.margin = '0';
  d.body.innerHTML = '';
  for (let i = 0; i < 200; i++) {
    const div = d.createElement('div');
    div.style.cssText = 'height:100px;box-sizing:border-box;background:' + (i % 2 ? '#dddddd' : '#eeeeee') + ';font-size:12px';
    div.textContent = 'row ' + i;
    d.body.appendChild(div);
  }
  const mk = (css, tag, uidv, txt) => {
    const e = d.createElement(tag || 'div');
    e.style.cssText = css;
    if (uidv) e.setAttribute('data-mcp-uid', uidv);
    e.textContent = txt || '';
    d.body.appendChild(e);
    return e;
  };
  // magenta target button at doc y=3000 (visible, gets snapshot uid)
  const mag = d.createElement('button');
  mag.id = 'magBtn'; mag.setAttribute('data-mcp-uid', 'mag1');
  mag.style.cssText = 'position:absolute;left:100px;top:3000px;width:220px;height:80px;background:#ff00ff;color:#fff;font-size:20px;border:0';
  mag.textContent = 'MAGENTA-TARGET';
  d.body.appendChild(mag);
  // cyan decoy at top doc y=320 (where a viewport-coords clip bug would land after centering)
  mk('position:absolute;left:100px;top:320px;width:220px;height:80px;background:#00ffff;color:#000', 'button', 'cyan1', 'CYAN-DECOY');
  // fixed lime bar bottom-right
  mk('position:fixed;right:20px;bottom:20px;width:180px;height:60px;background:#00ff00;z-index:9999', 'button', 'fix1', 'FIXED-LIME');
  // partial offscreen (sticks out right edge) orange
  mk('position:absolute;left:' + (innerWidth - 40) + 'px;top:1500px;width:200px;height:60px;background:#ff8800', 'button', 'part1', 'PART-OFFSCREEN');
  // hidden display:none red
  mk('display:none;position:absolute;left:50px;top:600px;width:150px;height:60px;background:#ff0000', 'button', 'dn1', 'HIDDEN-DN');
  // visibility:hidden blue (keeps layout box)
  mk('visibility:hidden;position:absolute;left:50px;top:700px;width:150px;height:60px;background:#0000ff', 'button', 'vh1', 'HIDDEN-VH');
  // zero-size
  mk('position:absolute;left:50px;top:800px;width:0;height:0;background:#123456', 'button', 'zero1', 'ZERO');
  // same-origin iframe (srcdoc) at doc y=4000 with a yellow button inside
  const f = d.createElement('iframe');
  f.style.cssText = 'position:absolute;left:300px;top:4000px;width:400px;height:200px;border:0';
  f.srcdoc = '<!doctype html><body style="margin:0;background:#ffffff"><button id="inB" style="position:absolute;left:30px;top:40px;width:160px;height:60px;background:#ffff00">IFRAME-YELLOW</button></body>';
  d.body.appendChild(f);
  return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, docH: document.documentElement.scrollHeight, built: true };
}`;
const ev = await call('evaluate_script', { pageId, function: buildSrc }, 3);
console.log('BUILD', ev.elapsed + 'ms', ev.text.slice(0, 400));

// let the iframe's srcdoc load, then snapshot
await new Promise(r => setTimeout(r, 1200));
const sn = await call('take_snapshot', { pageId }, 4);
console.log('SNAP', sn.elapsed + 'ms');
console.log(sn.text.slice(0, 3000));
console.log('PAGEID=' + pageId);
process.exit(0);
