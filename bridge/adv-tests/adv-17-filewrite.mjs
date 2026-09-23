// adv-17: file-write attack surface regression + bypass hunting against the
// hardened writeOut() (index.js:190-202).
// Policy under test:
//   - basename: no reserved names, no lead/trail space, no trailing '.'/'::', no ':' (ADS)
//   - repo protection: refuse ONLY IF resolved target is under PROJECT_ROOT AND exists
//   - everything else: mkdir -p + writeFileSync (arbitrary write)
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:7890/mcp';
let sid, i = 0;
const rpc = async b => {
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(b) });
  const t = await r.text();
  if (!sid) sid = r.headers.get('mcp-session-id');
  const m = t.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5).trim()));
  return { msg: m[m.length - 1], status: r.status };
};
await rpc({ jsonrpc: '2.0', id: ++i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv17', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = (n, a) => rpc({ jsonrpc: '2.0', id: ++i, method: 'tools/call', params: { name: n, arguments: a } });
const text = r => r.msg?.result?.content?.[0]?.text ?? JSON.stringify(r.msg);
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const exists = p => { try { return fs.existsSync(p); } catch { return 'ERR'; } };
const readIf = p => { try { return fs.readFileSync(p); } catch (e) { return null; } };

const ROOT = 'D:/Tool/chrome-mcp';
const BRIDGE = ROOT + '/bridge';
const ADV = BRIDGE + '/adv-tests';
const TEMP = 'C:/Users/29980/AppData/Local/Temp';
const APPDATA = 'C:/Users/29980/AppData/Roaming';
const CREATED = [];
const mark = p => { CREATED.push(p); return p; };
const CANARY = `${ADV}/canary17.txt`;
const CANARY_ORIG = 'CANARY-ORIGINAL-17';
fs.writeFileSync(CANARY, CANARY_ORIG);

const idx = `${BRIDGE}/index.js`;
const idxHash0 = sha(idx);
let idxRestored = false;

// local HTTP server for http_request byte-exact tests
let srvBytes = Buffer.alloc(0);
const srv = http.createServer((req, res) => {
  if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(srvBytes); }
  else if (req.url === '/bat') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('@echo off\r\necho ADV17-PWNED > %TEMP%\\adv17-bat-ran.txt\r\n'); }
  else { res.writeHead(404); res.end('x'); }
});
await new Promise(r => srv.listen(17990, '127.0.0.1', r));

const np = await call('new_page', { url: 'https://example.com' });
const npTxt = text(np);
console.log('new_page raw:', npTxt.slice(0, 300));
let pageId;
try { pageId = JSON.parse(npTxt.slice(npTxt.indexOf('{'))).pageId; } catch { pageId = np.msg?.result?.structuredContent?.pageId; }
if (!pageId) { console.log('NO PAGE — aborting'); process.exit(1); }
console.log('pageId=', pageId);

const ev = fp => ({ pageId, function: '() => "PWNED-CONTENT-17"', filePath: fp });
const shot = fp => ({ pageId, format: 'png', filePath: fp });
let n = 0;
const probe = async (label, args, opts = {}) => {
  const tool = opts.tool || 'evaluate_script';
  const a = args || ev(opts.fp);
  if (opts.resetCanary) fs.writeFileSync(CANARY, CANARY_ORIG);
  const hIdx = sha(idx);
  const r = await call(tool, a);
  const t = text(r).split('\n').slice(0, 3).join(' | ');
  const check = opts.check ? opts.check.map(p => `${p}=${exists(p)}`).join(';') : '';
  const canary = opts.resetCanary ? ` | canary=${readIf(CANARY)?.toString() === CANARY_ORIG ? 'INTACT' : '***OVERWRITTEN***'}` : '';
  const idxDiff = sha(idx) !== hIdx ? ' | !!!INDEX-CHANGED!!!' : '';
  console.log(`[${++n}] ${label}\n    resp: ${t.slice(0, 200)}\n    ${check}${canary}${idxDiff}`);
  if (sha(idx) !== idxHash0 && !idxRestored) {
    fs.copyFileSync(TEMP + '/adv17-index.js.bak', idx);
    idxRestored = true;
    console.log('    !!! index.js restored from backup');
  }
  return r;
};

console.log('\n===== A. REGRESSION: existing repo files must be REFUSED =====');
await probe('index.js exact', null, { fp: `${BRIDGE}/index.js` });
await probe('package.json', null, { fp: `${ROOT}/package.json` });
await probe('tools.js', null, { fp: `${BRIDGE}/tools.js` });
await probe('extension manifest', null, { fp: `${ROOT}/extension/manifest.json` });
await probe('.git/config', null, { fp: `${ROOT}/.git/config` });
await probe('.extension-id pin', null, { fp: `${BRIDGE}/.extension-id` });
await probe('canary exact', null, { fp: CANARY, resetCanary: true });
await probe('index.js ..\\..\\ norm', null, { fp: `${BRIDGE}/../bridge/index.js` });
await probe('index.js fwd-slash', null, { fp: 'D:/Tool/chrome-mcp/bridge/index.js' });
await probe('index.js .\\ seg', null, { fp: `${BRIDGE}/./index.js` });
await probe('relative index.js (cwd)', null, { fp: 'index.js' });
await probe('relative ..\\package.json', null, { fp: '../package.json' });
await probe('watchdog.mjs', null, { fp: `${BRIDGE}/watchdog.mjs` });
await probe('filePath=".." (root dir)', null, { fp: '..' });

console.log('\n===== B. BYPASS attempts vs canary (existing repo file) =====');
await probe('lowercase drive+dirs', null, { fp: 'd:\\tool\\chrome-mcp\\bridge\\adv-tests\\canary17.txt', resetCanary: true });
await probe('ALL-CAPS path', null, { fp: 'D:\\TOOL\\CHROME-MCP\\BRIDGE\\ADV-TESTS\\CANARY17.TXT', resetCanary: true });
await probe('\\\\?\\ verbatim', null, { fp: '\\\\?\\D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\canary17.txt', resetCanary: true });
await probe('\\\\?\\ verbatim + case', null, { fp: '\\\\?\\d:\\tool\\chrome-mcp\\bridge\\adv-tests\\canary17.txt', resetCanary: true });
await probe('\\\\.\\ device prefix', null, { fp: '\\\\.\\D:\\Tool\\chrome-mcp\\bridge\\adv-tests\\canary17.txt', resetCanary: true });
await probe('verbatim on index.js', null, { fp: '\\\\?\\D:\\Tool\\chrome-mcp\\bridge\\index.js' });
// junction realpath bypass: lexical path stays under Temp (outside PROJECT_ROOT)
// but the filesystem resolves it INTO the repo.
let junc = TEMP + '/adv17-junc';
let junc2 = TEMP + '/adv17-junc2';
try { execSync(`cmd.exe /c rmdir "${junc}" "${junc2}" 2>nul & mklink /J "${junc}" "${ADV}" & mklink /J "${junc2}" "${BRIDGE}"`); } catch {}
console.log('    junctions:', exists(junc), exists(junc2));
if (exists(junc)) {
  await probe('junction -> canary', null, { fp: `${junc}/canary17.txt`, resetCanary: true });
}
if (exists(junc2)) {
  await probe('junction -> index.js', null, { fp: `${junc2}/index.js` });
}
// ADS / trailing-dot / space on protected file (expect refused by basename rules)
await probe('canary ADS :x', null, { fp: `${CANARY}:pwn`, resetCanary: true });
await probe('canary trailing dot', null, { fp: CANARY + '.', resetCanary: true });
await probe('canary trailing space', null, { fp: CANARY + ' ', resetCanary: true });
// dir-component tricks that keep prefix but Windows folds
await probe('adv-tests. dir', null, { fp: `${ADV}./canary17.txt`, resetCanary: true });

console.log('\n===== C. NEW files inside repo (allowed by policy?) =====');
await probe('new file in bridge/', null, { fp: mark(`${BRIDGE}/adv17-new.txt`), check: [`${BRIDGE}/adv17-new.txt`] });
await probe('GIT HOOK pre-commit', null, { fp: mark(`${ROOT}/.git/hooks/pre-commit`), check: [`${ROOT}/.git/hooks/pre-commit`] });
await probe('GIT HOOK post-checkout', null, { fp: mark(`${ROOT}/.git/hooks/post-checkout`), check: [`${ROOT}/.git/hooks/post-checkout`] });
await probe('new file in extension/', null, { fp: mark(`${ROOT}/extension/adv17-pwn.js`), check: [`${ROOT}/extension/adv17-pwn.js`] });
await probe('node_modules plant', null, { fp: mark(`${BRIDGE}/node_modules/adv17-pwn/index.js`), check: [`${BRIDGE}/node_modules/adv17-pwn/index.js`] });
await probe('.vscode tasks', null, { fp: mark(`${ROOT}/.vscode/tasks.json`), check: [`${ROOT}/.vscode/tasks.json`] });

console.log('\n===== D. Outside repo — map allowed roots =====');
await probe('user TEMP', null, { fp: mark(`${TEMP}/adv17-temp.txt`), check: [`${TEMP}/adv17-temp.txt`] });
await probe('C:/Windows/Temp', null, { fp: mark('C:/Windows/Temp/adv17.txt'), check: ['C:/Windows/Temp/adv17.txt'] });
await probe('Desktop', null, { fp: mark('C:/Users/29980/Desktop/adv17.txt'), check: ['C:/Users/29980/Desktop/adv17.txt'] });
await probe('Downloads', null, { fp: mark('C:/Users/29980/Downloads/adv17.txt'), check: ['C:/Users/29980/Downloads/adv17.txt'] });
await probe('hosts (expect EPERM, non-admin)', null, { fp: 'C:/Windows/System32/drivers/etc/hosts', check: ['C:/Windows/System32/drivers/etc/hosts'] });
await probe('System32 new file', null, { fp: 'C:/Windows/System32/adv17.txt', check: ['C:/Windows/System32/adv17.txt'] });
await probe('UNC c$', null, { fp: '\\\\127.0.0.1\\c$\\adv17.txt', check: ['//127.0.0.1/c$/adv17.txt'] });
await probe('UNC localhost c$', null, { fp: '\\\\localhost\\c$\\adv17.txt' });
await probe('\\\\?\\UNC', null, { fp: '\\\\?\\UNC\\127.0.0.1\\c$\\adv17.txt' });
await probe('traversal ..\\..\\ -> D:/Tool', null, { fp: mark('../../adv17-trav.txt'), check: ['D:/Tool/adv17-trav.txt'] });
await probe('repo/../outside', null, { fp: mark(`${ROOT}/../adv17-outside.txt`), check: ['D:/Tool/adv17-outside.txt'] });
await probe('drive-relative C:', null, { fp: 'C:adv17-cdrv.txt', check: ['C:/adv17-cdrv.txt'] });
await probe('POSIX /etc/passwd', null, { fp: mark('/etc/adv17-passwd'), check: ['D:/etc/adv17-passwd'] });
await probe('D:/ root new file', null, { fp: mark('D:/adv17-root.txt'), check: ['D:/adv17-root.txt'] });

console.log('\n===== E. Startup folder — persistence primitive =====');
const startup = `${APPDATA}/Microsoft/Windows/Start Menu/Programs/Startup`;
await probe('Startup evil.bat (eval)', null, { fp: mark(`${startup}/adv17-evil.bat`), check: [`${startup}/adv17-evil.bat`] });
const rb = await call('http_request', { url: 'http://127.0.0.1:17990/bat', filePath: `${startup}/adv17-pwn.bat` });
console.log(`[${++n}] Startup .bat via http_request\n    resp: ${text(rb).split('\n').slice(0, 2).join(' | ')}`);
if (exists(`${startup}/adv17-pwn.bat`)) {
  console.log('    !!! bat content:', JSON.stringify(fs.readFileSync(`${startup}/adv17-pwn.bat`, 'utf8')));
  mark(`${startup}/adv17-pwn.bat`);
}
await probe('Startup evil.lnk/.exe name', null, { fp: mark(`${startup}/adv17-evil.exe`), check: [`${startup}/adv17-evil.exe`] });

console.log('\n===== F. Filename edge cases =====');
for (const [label, name] of [
  ['CON.txt', 'CON.txt'], ['NUL', 'NUL'], ['AUX.txt', 'AUX.txt'], ['COM1.txt', 'COM1.txt'], ['LPT9.txt', 'LPT9.txt'],
  ['CONIN$', 'CONIN$'], ['CONOUT$', 'CONOUT$'], ['com0.txt', 'com0.txt'], ['LPT0.txt', 'LPT0.txt'],
  ['COM¹ superscript', 'COM¹.txt'], ['con .txt', 'con .txt'], ['nul .txt', 'nul .txt'],
  ['trail dot', 'adv17.'], ['trail space', 'adv17 '], ['lead space', ' adv17.txt'],
  ['ADS :hidden', 'adv17.txt:hidden'], ['ADS :$DATA', 'x:$DATA'], ['dotdot ..', '..'], ['...', '...'],
]) {
  const fp = `${ADV}/${name}`;
  const r = await probe(label, null, { fp });
  if (exists(fp) && !name.includes('..')) mark(fp);
}
await probe('NUL via \\\\.\\', null, { fp: '\\\\.\\NUL' });
await probe('null byte', null, { fp: `${ADV}/nb.txt${String.fromCharCode(0)}.png` });
await probe('300-char segment', null, { fp: `${ADV}/` + 'a'.repeat(280) + '.txt' });
await probe('filePath number', null, { fp: 123 });
await probe('filePath object', null, { fp: { x: 1 } });

console.log('\n===== G. Race / stress / robustness =====');
// concurrent same-target writes
const rTarget = mark(`${TEMP}/adv17-race.png`);
const rs = await Promise.all(Array.from({ length: 8 }, () => call('take_screenshot', shot(rTarget))));
console.log(`[${++n}] 8x concurrent same file: ${rs.map(r => text(r).split('\n')[0]).join(' || ').slice(0, 160)}`);
console.log('    final file ok:', readIf(rTarget)?.slice(1, 4)?.toString() === 'PNG', 'size:', readIf(rTarget)?.length);
// filePath = existing dir
await probe('filePath=dir C:/Windows/Temp', null, { fp: 'C:/Windows/Temp' });
await probe('filePath=dir adv-tests', null, { fp: ADV });
// read-only target
const ro = `${TEMP}/adv17-ro.txt`;
fs.writeFileSync(ro, 'ro'); fs.chmodSync(ro, 0o444); mark(ro);
await probe('read-only target', null, { fp: ro });
fs.chmodSync(ro, 0o666);
// open handle while bridge writes
const oh = `${TEMP}/adv17-openhandle.txt`;
fs.writeFileSync(oh, 'held'); mark(oh);
const fh = fs.openSync(oh, 'r+');
await probe('open-handle target', null, { fp: oh });
fs.closeSync(fh);
console.log('    open-handle content now:', JSON.stringify(readIf(oh)?.toString()?.slice(0, 40)));
// big binary via http_request (8MB)
srvBytes = crypto.randomBytes(8 * 1024 * 1024);
const big = mark(`${TEMP}/adv17-big.bin`);
const t0 = Date.now();
const rBig = await call('http_request', { url: 'http://127.0.0.1:17990/bin', filePath: big });
console.log(`[${++n}] 8MB http_request -> file\n    resp: ${text(rBig).split('\n')[0].slice(0, 120)} | wrote ${exists(big) ? fs.statSync(big).size : 'NO'} bytes in ${Date.now() - t0}ms | sha match: ${exists(big) && sha(big) === crypto.createHash('sha256').update(srvBytes).digest('hex')}`);

console.log('\n===== H. Content integrity =====');
const png = mark(`${TEMP}/adv17-shot.png`);
const rPng = await call('take_screenshot', shot(png));
const b = readIf(png);
console.log(`[${++n}] png magic=${b?.slice(0, 4)?.toString('hex')} iend-tail=${b?.slice(-8)?.toString('hex')} size=${b?.length}`);
const js = mark(`${TEMP}/adv17-eval.json`);
await call('evaluate_script', { pageId, function: '() => ({a:1, s:"line1\\nline2 Ω", arr:[1,2,3]})', filePath: js });
console.log(`[${++n}] eval file content: ${readIf(js)?.toString()}`);
srvBytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x00, 0x4d, 0x5a, 13, 10, 26]);
const bin = mark(`${TEMP}/adv17-bytes.bin`);
await call('http_request', { url: 'http://127.0.0.1:17990/bin', filePath: bin });
console.log(`[${++n}] binary round-trip equal: ${readIf(bin)?.equals(srvBytes)}`);

console.log('\n===== I. get_network_request dual-path writes =====');
await call('list_network_requests', { pageId });
await call('evaluate_script', { pageId, function: '() => fetch("/").then(r=>r.status)' });
await new Promise(r => setTimeout(r, 1500));
const lnr = text(await call('list_network_requests', { pageId }));
let reqid; try { const arr = JSON.parse(lnr.slice(lnr.indexOf('{'))).requests; reqid = arr?.[arr.length - 1]?.reqid; } catch {}
if (reqid != null) {
  const rf = mark(`${TEMP}/adv17-req.txt`), sf = mark(`${TEMP}/adv17-resp.txt`);
  const g = await call('get_network_request', { pageId, reqid, requestFilePath: rf, responseFilePath: sf });
  console.log(`[${++n}] get_network_request resp: ${text(g).split('\n').slice(0, 3).join(' | ').slice(0, 200)} | req=${exists(rf)} resp=${exists(sf)}`);
}

console.log('\n===== J. download_file filename traversal =====');
for (const fn of ['..\\adv17-dl-esc.html', '..\\..\\..\\Windows\\Temp\\adv17-dl.html', 'adv17-sub\\ok.html']) {
  const d = await call('download_file', { url: 'http://127.0.0.1:17990/bat', filename: fn });
  console.log(`[${++n}] download_file filename=${JSON.stringify(fn)}\n    resp: ${text(d).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
}
const dl = text(await call('list_downloads', { limit: 5 }));
console.log('    recent downloads:', dl.slice(0, 600));

console.log('\n===== CLEANUP =====');
await call('close_page', { pageId });
for (const p of CREATED) {
  try { fs.rmSync(p, { recursive: true, force: true }); console.log('  rm', p); }
  catch (e) { console.log('  rm FAIL', p, e.message); }
}
try { execSync(`cmd.exe /c rmdir "${junc}" "${junc2}"`); console.log('  rmdir junctions'); } catch (e) { console.log('  junction rm fail', e.message); }
// stray artifacts from edge cases
for (const p of [CANARY, `${TEMP}/index.js`, `${ADV}/com0.txt`, `${ADV}/lpt0.txt`, `${ADV}/...`, 'C:/Windows/Temp/mcp-pwn.txt', `${ADV}/../adv17-trav.txt`]) {
  try { if (exists(p)) { fs.rmSync(p, { force: true }); console.log('  rm stray', p); } } catch {}
}
if (sha(idx) !== idxHash0) { fs.copyFileSync(TEMP + '/adv17-index.js.bak', idx); console.log('  index.js restored (final)'); }
srv.close();
console.log('DONE. index.js intact:', sha(idx) === idxHash0);
