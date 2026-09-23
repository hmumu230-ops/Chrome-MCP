// adv-14b: retest foreign-domain cookie + http secure cookie with populated tab.url,
// plus cleanup of files left in D:\Downloads and stray test cookies.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv14b', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const unpack = r => {
  const res = r && r.msg && r.msg.result;
  if (!res) return { transportError: JSON.stringify(r.msg || r.status).slice(0, 200) };
  if (res.isError) return { ERROR: (res.content?.[0]?.text || '').replace(/^Error: /, '').slice(0, 300) };
  if (res.structuredContent !== undefined) return res.structuredContent;
  const txt = res.content?.[0]?.text || '';
  try { return JSON.parse(txt.slice(txt.indexOf('{'))); } catch { return { text: txt.slice(0, 300) }; }
};
const P = (d, r) => { const u = unpack(r); console.log(d, '->', JSON.stringify(u).slice(0, 400)); return u; };

const DLR = 'D:/Downloads';
console.log('downloads dir listing (adv14/win.ini artifacts):');
for (const f of fs.readdirSync(DLR)) if (/adv14|^win\.ini|crdownload/i.test(f)) console.log('  ', f);

// active tabs so url commits
const pg = unpack(await call('new_page', { url: 'https://github.com' })).pageId;
const ph = unpack(await call('new_page', { url: 'http://neverssl.com' })).pageId;
const pe = unpack(await call('new_page', { url: 'https://example.com' })).pageId;
await new Promise(r => setTimeout(r, 3000));
const pages = unpack(await call('list_pages', {}));
const urls = {};
for (const t of (pages.items || pages)) if ([pg, ph, pe].includes(t.pageId)) urls[t.pageId] = t.url;
console.log('tab urls:', JSON.stringify(urls));

P('FOREIGN: set httpOnly+secure .github.com cookie via github tab', await call('set_cookie', { pageId: pg, name: 'adv14sess', value: 'FIXATION-PWN', domain: '.github.com', httpOnly: true, secure: true }));
const g = P('get_cookies on github tab (real session cookies leak?)', await call('get_cookies', { pageId: pg }));
if (g.cookies) console.log('   github.com cookies:', g.cookies.length, g.cookies.map(c => c.name + (c.httpOnly ? '(httpOnly)' : '')).join(', ').slice(0, 300));
P('secure cookie on http tab', await call('set_cookie', { pageId: ph, name: 'adv14_httpsec', value: '1', secure: true }));
P('httpOnly cookie on http tab', await call('set_cookie', { pageId: ph, name: 'adv14_httponly', value: '1', httpOnly: true }));
P('plain cookie on http tab', await call('set_cookie', { pageId: ph, name: 'adv14_httpplain', value: '1' }));
P('sameSite no_restriction on http tab', await call('set_cookie', { pageId: ph, name: 'adv14_sshttp', value: '1', sameSite: 'no_restriction' }));
// also: does the empty-name artifact cookie exist? clean it
const ge = P('get_cookies example.com (check empty-name artifact)', await call('get_cookies', { pageId: pe }));
if (ge.cookies) console.log('   example.com cookies:', ge.cookies.map(c => JSON.stringify(c.name)).join(','));

// ---------- CLEANUP ----------
console.log('--- cleanup ---');
for (const [pid, nm] of [[pg, 'adv14sess'], [ph, 'adv14_httpsec'], [ph, 'adv14_httponly'], [ph, 'adv14_httpplain'], [ph, 'adv14_sshttp']])
  P(`remove ${nm}`, await call('remove_cookie', { pageId: pid, name: nm }));
// remove empty-name + any adv14 leftovers on example.com
const ge2 = unpack(await call('get_cookies', { pageId: pe }));
if (ge2.cookies) for (const c of ge2.cookies.filter(c => c.name === '' || c.name.startsWith('adv14') || c.name === 'a b'))
  P(`remove stray '${c.name}'`, await call('remove_cookie', { pageId: pe, name: c.name }));

for (const f of ['win.ini', 'adv14-self.json', 'adv14-big.bin', 'adv14-data.txt', 'adv14-chrome.txt', 'adv14-js.txt', 'adv14-nx.txt']) {
  for (const p of [path.join(DLR, f), path.join(DLR, f + '.crdownload')])
    try { fs.unlinkSync(p); console.log('  deleted', p); } catch {}
}
for (const d of ['adv14sub', 'adv14bs']) {
  try { fs.rmSync(path.join(DLR, d), { recursive: true }); console.log('  deleted dir', path.join(DLR, d)); } catch {}
}
// verify
const left = fs.readdirSync(DLR).filter(f => /adv14|^win\.ini|crdownload/i.test(f));
console.log('leftover artifacts:', JSON.stringify(left));
for (const pid of [pg, ph, pe]) if (pid) await call('close_page', { pageId: pid });
console.log('done');
