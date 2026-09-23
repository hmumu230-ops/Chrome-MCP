// adv-14c: secure-cookie-on-http retest (localhost + retry http site),
// auth-riding PoC via http_request (redacted), final cleanup.
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv14c', version: '0' } } });
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
const P = (d, r) => { const u = unpack(r); console.log(d, '->', JSON.stringify(u).slice(0, 350)); return u; };

// http tab that commits instantly: the bridge itself
const pl = unpack(await call('new_page', { url: 'http://127.0.0.1:7890/' })).pageId;
await new Promise(r => setTimeout(r, 1500));
const pages = unpack(await call('list_pages', {}));
const t = (pages.items || pages).find(t => t.pageId === pl);
console.log('bridge tab url:', t && t.url);

P('secure cookie on http://127.0.0.1', await call('set_cookie', { pageId: pl, name: 'adv14_lsec', value: '1', secure: true }));
P('plain cookie on http://127.0.0.1', await call('set_cookie', { pageId: pl, name: 'adv14_lplain', value: '1' }));
P('sameSite no_restriction+secure on http://127.0.0.1', await call('set_cookie', { pageId: pl, name: 'adv14_lss', value: '1', secure: true, sameSite: 'no_restriction' }));

// auth-riding: GET github.com with credentials:'include' — logged-in markers?
const gh = unpack(await call('http_request', { url: 'https://github.com/', timeout: 15000 }));
if (gh.ERROR) console.log('github fetch ->', gh.ERROR);
else {
  const body = gh.body || '';
  console.log('github fetch status:', gh.status, 'bytes:', body.length,
    '| logged-in markers:', /user-login|dashboard|logged_in/i.test(body) && !/Sign in to GitHub/i.test(body.slice(0, 5000)));
}

// cleanup
for (const nm of ['adv14_lsec', 'adv14_lplain', 'adv14_lss']) P('remove ' + nm, await call('remove_cookie', { pageId: pl, name: nm }));
try { fs.unlinkSync('D:/Downloads/Unconfirmed 164351.crdownload'); console.log('deleted .crdownload'); } catch (e) { console.log('crdownload delete:', e.message); }
// final cookie sweep on github tab: open + verify adv14sess gone
const pg = unpack(await call('new_page', { url: 'https://github.com' })).pageId;
await new Promise(r => setTimeout(r, 1500));
const g2 = unpack(await call('get_cookies', { pageId: pg }));
if (g2.cookies) {
  const left = g2.cookies.filter(c => c.name.startsWith('adv14'));
  console.log('adv14 leftovers on github:', left.length, left.map(c => c.name).join(','));
  for (const c of left) await call('remove_cookie', { pageId: pg, name: c.name });
}
for (const pid of [pl, pg]) if (pid) await call('close_page', { pageId: pid });
console.log('done');
