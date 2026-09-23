// adv-14: adversarial tests for get_cookies/set_cookie/remove_cookie,
// download_file/list_downloads, http_request. Run: node adv-14-cookie.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv14', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });

const DL = path.join(os.homedir(), 'Downloads');
const HOME = os.homedir();
const results = [];
let n = 0;
const unpack = r => {
  const res = r && r.msg && r.msg.result;
  if (!res) return { transportError: JSON.stringify(r.msg || r.status).slice(0, 200) };
  if (res.isError) return { ERROR: (res.content?.[0]?.text || '').replace(/^Error: /, '').slice(0, 300) };
  if (res.structuredContent !== undefined) return res.structuredContent;
  const txt = res.content?.[0]?.text || '';
  try { return JSON.parse(txt.slice(txt.indexOf('{'))); } catch { return { text: txt.slice(0, 300) }; }
};
const rec = (desc, r, extra) => {
  const u = unpack(r);
  const s = JSON.stringify(u);
  results.push({ n: ++n, desc, ...(extra || {}), result: s.length > 600 ? s.slice(0, 600) + '…' : u });
  console.log(`[${String(n).padStart(2)}] ${desc}\n     -> ${s.slice(0, 400)}`);
  return u;
};
const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };

// ---------- SETUP ----------
const p1 = unpack(await call('new_page', { url: 'https://example.com' })).pageId;
const p2 = unpack(await call('new_page', { url: 'https://github.com', background: true })).pageId;
const p3 = unpack(await call('new_page', { url: 'http://neverssl.com', background: true })).pageId;
const p4 = unpack(await call('new_page', { url: 'chrome://version', background: true })).pageId;
console.log('tabs:', { p1, p2, p3, p4 });
const pages = unpack(await call('list_pages', {}));
console.log('resolved tab urls:', JSON.stringify((pages.items || pages).filter(t => [p1, p2, p3, p4].includes(t.pageId)).map(t => ({ id: t.pageId, url: t.url }))));

// ---------- COOKIES ----------
rec('set_cookie foreign: url arg=https://google.com + domain=.github.com on example.com tab', await call('set_cookie', { pageId: p1, name: 'adv14_f1', value: '1', url: 'https://google.com', domain: '.github.com' }));
rec('set_cookie domain=github.com on example.com tab', await call('set_cookie', { pageId: p1, name: 'adv14_f2', value: '1', domain: 'github.com' }));
rec('set_cookie domain=.com (public suffix) on example.com tab', await call('set_cookie', { pageId: p1, name: 'adv14_f3', value: '1', domain: '.com' }));
rec('set_cookie baseline httpOnly+secure domain=.example.com', await call('set_cookie', { pageId: p1, name: 'adv14_ok', value: 'v1', domain: '.example.com', httpOnly: true, secure: true }));
rec("injection: name 'a;b'", await call('set_cookie', { pageId: p1, name: 'a;b', value: 'x' }));
rec("injection: name 'a b' (space)", await call('set_cookie', { pageId: p1, name: 'a b', value: 'x' }));
rec("injection: value 'ok\\r\\nSet-Cookie: evil=1'", await call('set_cookie', { pageId: p1, name: 'adv14_crlf', value: 'ok\r\nSet-Cookie: evil=1' }));
rec("injection: value 'v;v'", await call('set_cookie', { pageId: p1, name: 'adv14_semi', value: 'v;v' }));
rec('expires far past (epoch=1)', await call('set_cookie', { pageId: p1, name: 'adv14_past', value: '1', expirationDate: 1 }));
rec('expires far future (99999999999999)', await call('set_cookie', { pageId: p1, name: 'adv14_far', value: '1', expirationDate: 99999999999999 }));
rec('expires negative (-5)', await call('set_cookie', { pageId: p1, name: 'adv14_neg', value: '1', expirationDate: -5 }));
rec("sameSite 'None' (literal, not in enum)", await call('set_cookie', { pageId: p1, name: 'adv14_ss0', value: '1', sameSite: 'None' }));
rec("sameSite no_restriction WITHOUT secure", await call('set_cookie', { pageId: p1, name: 'adv14_ss1', value: '1', sameSite: 'no_restriction' }));
rec("sameSite no_restriction WITH secure", await call('set_cookie', { pageId: p1, name: 'adv14_ss2', value: '1', sameSite: 'no_restriction', secure: true }));
rec('secure+httpOnly on http tab (neverssl)', await call('set_cookie', { pageId: p3, name: 'adv14_httpsec', value: '1', secure: true, httpOnly: true }));
rec('plain cookie on http tab', await call('set_cookie', { pageId: p3, name: 'adv14_httpplain', value: '1' }));
rec('sameSite no_restriction on http tab', await call('set_cookie', { pageId: p3, name: 'adv14_sshttp', value: '1', sameSite: 'no_restriction' }));
rec('FOREIGN DOMAIN: httpOnly+secure cookie on github.com tab (.github.com)', await call('set_cookie', { pageId: p2, name: 'adv14sess', value: 'FIXATION-PWN', domain: '.github.com', httpOnly: true, secure: true }));
const gc2 = rec('get_cookies on github.com tab (any real github cookies = session leak)', await call('get_cookies', { pageId: p2 }));
if (gc2.cookies) console.log('     github cookie count:', gc2.cookies.length, 'names:', gc2.cookies.map(c => c.name + (c.httpOnly ? '(httpOnly)' : '')).join(','));
rec('get_cookies on chrome:// tab', await call('get_cookies', { pageId: p4 }));
rec('set_cookie on chrome:// tab', await call('set_cookie', { pageId: p4, name: 'adv14_chrome', value: '1' }));
const gc1 = rec('get_cookies on example.com tab (should NOT include github cookie -> scoping check)', await call('get_cookies', { pageId: p1 }));
if (gc1.cookies) console.log('     example.com cookie names:', gc1.cookies.map(c => c.name).join(','));
rec("get_cookies name filter 'adv14_ok'", await call('get_cookies', { pageId: p1, name: 'adv14_ok' }));
rec('remove_cookie nonexistent', await call('remove_cookie', { pageId: p1, name: 'definitely_not_here_xyz' }));

// ---------- DOWNLOADS ----------
rec("download file:///C:/Windows/win.ini", await call('download_file', { url: 'file:///C:/Windows/win.ini', filename: 'adv14-win.ini' }));
rec("download chrome://version", await call('download_file', { url: 'chrome://version', filename: 'adv14-chrome.txt' }));
const dData = rec("download data:text/plain,...", await call('download_file', { url: 'data:text/plain,adv14-data-payload', filename: 'adv14-data.txt' }));
rec("download javascript:alert(1)", await call('download_file', { url: 'javascript:alert(1)', filename: 'adv14-js.txt' }));
rec("download self http://127.0.0.1:7890/", await call('download_file', { url: 'http://127.0.0.1:7890/', filename: 'adv14-self.json' }));
rec("download https://nonexistent.invalid/x", await call('download_file', { url: 'https://nonexistent.invalid/x', filename: 'adv14-nx.txt' }));
const dTrav = rec("TRAVERSAL filename='../adv14-trav.txt'", await call('download_file', { url: 'data:text/plain,traversal-pwn', filename: '../adv14-trav.txt' }));
const dAbs = rec("ABSOLUTE filename='C:/Windows/Temp/adv14-abs.txt'", await call('download_file', { url: 'data:text/plain,abs-pwn', filename: 'C:/Windows/Temp/adv14-abs.txt' }));
rec("subdir filename='adv14sub/nested.txt'", await call('download_file', { url: 'data:text/plain,sub', filename: 'adv14sub/nested.txt' }));
rec("backslash filename='adv14bs\\\\x.txt'", await call('download_file', { url: 'data:text/plain,bs', filename: 'adv14bs\\x.txt' }));
const bigUrl = 'data:application/octet-stream;base64,' + 'QUJD'.repeat(75000); // ~300KB body, ~300KB URL
rec('huge data: URL (~300KB)', await call('download_file', { url: bigUrl, filename: 'adv14-big.bin' }));
const ld = rec('list_downloads limit=5 (user full history?)', await call('list_downloads', { limit: 5 }));
if (ld.downloads) console.log('     downloads exposed:', ld.downloads.length, 'sample fields:', Object.keys(ld.downloads[0] || {}).join(','));

// ---------- HTTP_REQUEST ----------
rec("http_request file:///C:/Windows/win.ini", await call('http_request', { url: 'file:///C:/Windows/win.ini' }));
rec("http_request closed port 127.0.0.1:9", await call('http_request', { url: 'http://127.0.0.1:9/', timeout: 5000 }));
rec("http_request metadata http://169.254.169.254/", await call('http_request', { url: 'http://169.254.169.254/', timeout: 5000 }));
rec("http_request self http://127.0.0.1:7890/", await call('http_request', { url: 'http://127.0.0.1:7890/', timeout: 5000 }));
const arb = 'D:/Tool/chrome-mcp/adv14-arbwrite-poc.txt';
rec('http_request filePath -> bridge-side write ' + arb, await call('http_request', { url: 'http://127.0.0.1:7890/', filePath: arb }), { check: exists(arb) });
if (exists(arb)) { console.log('     !!! bridge wrote file, size:', fs.statSync(arb).size); fs.unlinkSync(arb); }

// ---------- CLEANUP ----------
console.log('\n=== CLEANUP ===');
for (const [pid, nm] of [[p1, 'adv14_ok'], [p1, 'adv14_ss2'], [p1, 'adv14_crlf'], [p1, 'adv14_semi'], [p1, 'adv14_past'], [p1, 'adv14_far'], [p1, 'adv14_neg'], [p1, 'adv14_ss0'], [p1, 'adv14_ss1'], [p1, 'adv14_f1'], [p1, 'adv14_f2'], [p1, 'adv14_f3'], [p2, 'adv14sess'], [p3, 'adv14_httpsec'], [p3, 'adv14_httpplain'], [p3, 'adv14_sshttp'], [p4, 'adv14_chrome']]) {
  const r = unpack(await call('remove_cookie', { pageId: pid, name: nm }));
  if (!r.ERROR) console.log('  removed', nm, 'on tab', pid);
}
// sweep: anything left named adv14*
for (const pid of [p1, p2, p3, p4]) {
  const g = unpack(await call('get_cookies', { pageId: pid }));
  if (g.cookies) for (const c of g.cookies.filter(c => c.name.startsWith('adv14') || c.name.startsWith('a;'))) {
    await call('remove_cookie', { pageId: pid, name: c.name });
    console.log('  swept leftover', c.name, 'on tab', pid);
  }
}
// delete downloaded files
const victims = [dData, dTrav, dAbs].map(d => d && d.filename).filter(Boolean);
const candidates = new Set(victims);
for (const f of ['adv14-win.ini', 'adv14-chrome.txt', 'adv14-data.txt', 'adv14-js.txt', 'adv14-self.json', 'adv14-nx.txt', 'adv14-trav.txt', 'adv14-big.bin', 'adv14bs\\x.txt', 'adv14sub\\nested.txt', 'adv14sub/nested.txt']) candidates.add(path.join(DL, f));
candidates.add(path.join(HOME, 'adv14-trav.txt'));
candidates.add('C:/Windows/Temp/adv14-abs.txt');
candidates.add(path.join(DL, '../adv14-trav.txt'));
for (const f of candidates) {
  for (const p of [f, f + '.crdownload']) if (exists(p)) { try { fs.unlinkSync(p); console.log('  deleted', p); } catch (e) { console.log('  FAILED delete', p, e.message); } }
}
try { fs.rmdirSync(path.join(DL, 'adv14sub')); } catch {}
for (const pid of [p1, p2, p3, p4]) { if (pid) await call('close_page', { pageId: pid }); }
console.log('done');
