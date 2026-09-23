// adv-16-download.mjs — adversarial tests for download_file / list_downloads.
// Run on Windows: node.exe adv-tests\adv-16-download.mjs [phase]
// Phases: A=scheme regression, B=filename arg traversal, C=Content-Disposition,
//         D=behavior (concurrent/dup/interrupt/zero/confuse/redir), E=history, F=integrity, G=danger
// Requires adv-16-dl-server.mjs running on 127.0.0.1:8127 for B,C,D,F,G.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:7890/mcp';
const DL = 'D:\\Downloads';
const DL_PORT = process.argv[3] || process.env.DL_PORT || '8127';
const BASE2 = 'http://127.0.0.1:' + DL_PORT;
const PHASE = (process.argv[2] || 'all').toUpperCase();
let sid = null, idc = 0;

async function req(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const t = await res.text();
  const dataLine = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
  try { return JSON.parse(dataLine || t); } catch { return { raw: t }; }
}

const init = await req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adv16', version: '0' } });
if (init.error) { console.error('INIT FAILED', init); process.exit(1); }

const findings = [];
const note = (tag, msg) => { findings.push(`[${tag}] ${msg}`); console.log(`  *** [${tag}] ${msg}`); };

async function call(tool, args, ms = 130000) {
  const r = await Promise.race([
    req('tools/call', { name: tool, arguments: args }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('driver timeout ' + ms)), ms)),
  ]);
  return r.result ?? r;
}
const txt = r => (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r);
const isErr = r => !!(r && (r.isError || (r.content && /error|refus|only accepts|denied|invalid/i.test(txt(r) || '') && !/"state"\s*:\s*"complete"/.test(txt(r)))));

function show(name, r) {
  const t = (txt(r) || '').replace(/\s+/g, ' ').slice(0, 300);
  console.log(`${isErr(r) ? 'ERR ' : 'OK  '}${name}: ${t}`);
  return r;
}

function fsExists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function sha256file(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function dlListing() { try { return fs.readdirSync(DL); } catch { return []; } }
function myFiles() { return dlListing().filter(f => f.toLowerCase().includes('mcp-test')); }
function cleanupMine() {
  const killed = [];
  for (const f of myFiles()) {
    try { fs.rmSync(path.join(DL, f), { recursive: true, force: true }); killed.push(f); } catch (e) { killed.push(f + ' (FAILED: ' + e.message + ')'); }
  }
  // also check escaped locations we might have created
  for (const p of ['D:\\mcp-test-trav.bat', 'D:\\mcp-test-trav2.bat', 'C:\\mcp-test-abs.txt', 'C:\\mcp-test-cd-abs.bat',
                   'D:\\mcp-test-cd-evil.bat', 'D:\\mcp-test-cd-evil2.bat',
                   'C:\\Windows\\Temp\\mcp-test-t.bat', 'D:\\Tool\\mcp-test-trav2.bat']) {
    if (fsExists(p)) { try { fs.rmSync(p, { force: true }); killed.push('ESCAPED:' + p); } catch { killed.push('ESCAPED-FAIL:' + p); } }
  }
  return killed;
}

const before = myFiles();
console.log('=== adv-16 download_file tests. pre-existing mcp-test files in DL:', JSON.stringify(before));

// ---------- PHASE A: scheme regression ----------
if (PHASE === 'A' || PHASE === 'ALL') {
  console.log('\n--- PHASE A: scheme regression (must be refused: file/chrome/blob/js/malformed; data: per code is ALLOWED) ---');
  const cases = [
    ['file:///C:/Windows/win.ini', 'file-winini'],
    ['file:///C:/Windows/System32/drivers/etc/hosts', 'file-hosts'],
    ['FILE:///C:/Windows/win.ini', 'file-upper'],
    ['file://127.0.0.1/C$/Windows/win.ini', 'file-unc'],
    ['chrome://version/', 'chrome-ver'],
    ['chrome-extension://abcdef/manifest.json', 'chrome-ext'],
    ['blob:http://127.0.0.1:8127/11111111-2222-3333-4444-555555555555', 'blob'],
    ['javascript:alert(1)', 'js'],
    ['data:text/plain;base64,bWNwLXRlc3QgZGF0YSBzY2hlbWU=', 'data-scheme', { filename: 'mcp-test-data.txt' }],
    ['data:text/html;base64,PGI+ZG90YTwvYj4=', 'data-no-name'],
    ['ftp://127.0.0.1/x', 'ftp'],
    ['http://', 'malformed-empty'],
    ['http://[::1', 'malformed-bracket'],
    ['ht tp://x/', 'malformed-space'],
    [' http://127.0.0.1:8127/file/testfile.txt', 'leading-space'],
    ['', 'empty-string'],
    ['http:example.com', 'http-noslash'],
    ['HTTP://127.0.0.1:8127/file/testfile.txt', 'http-upper', { filename: 'mcp-test-upper.txt' }],
    ['https://127.0.0.1:1/x', 'https-refused-port'],
    ['\\\\127.0.0.1\\c$\\Windows\\win.ini', 'unc-bare'],
    ['file:win.ini', 'file-rel'],
  ];
  for (const [url, name, extra] of cases) {
    try {
      const r = await call('download_file', { url, ...(extra || {}) }, 45000);
      const t = txt(r);
      const complete = /"state"\s*:\s*"complete"/.test(t);
      if (complete) { note('SECURITY?', `${name}: ${url} -> COMPLETED: ${t.slice(0, 200)}`); }
      else show(name, r);
    } catch (e) { console.log('EXC ' + name + ': ' + e.message); }
  }
}

// ---------- PHASE B: filename argument traversal ----------
if (PHASE === 'B' || PHASE === 'ALL') {
  console.log('\n--- PHASE B: filename arg traversal/sanitization ---');
  const cases = [
    ['..\\mcp-test-trav.bat', 'trav-1'],
    ['..\\..\\mcp-test-trav2.bat', 'trav-2'],
    ['..\\..\\..\\Windows\\Temp\\mcp-test-t.bat', 'trav-temp'],
    ['mcp-test-subdir/inner.txt', 'subdir-fwd'],
    ['mcp-test-subdir2\\inner2.txt', 'subdir-back'],
    ['C:\\mcp-test-abs.txt', 'abs-win'],
    ['/etc/mcp-test-nix.txt', 'abs-nix'],
    ['mcp-test-dot.', 'trailing-dot'],
    ['mcp-test-space ', 'trailing-space'],
    ['..%5c..%5cmcp-test-pct.bat', 'pct-backslash'],
    ['%2e%2e%2fmcp-test-pct2.bat', 'pct-fwd'],
    ['con.txt', 'reserved-con'],
    ['mcp-test-normal.txt', 'normal'],
    ['a/b/c/d/mcp-test-deep.txt', 'deep-subdir'],
    ['.\\mcp-test-dotcur.txt', 'dot-cur'],
    ['...\\mcp-test-triple.bat', 'triple-dot'],
    ['mcp-test-uni"q.txt', 'quote'],
    ['mcp-test-co<lon.txt', 'lt'],
    ['mcp-test-que?st.txt', 'quest'],
    ['mcp-test-pipe|.txt', 'pipe'],
  ];
  for (const [filename, name] of cases) {
    try {
      const r = await call('download_file', { url: BASE2 + '/file/testfile.txt', filename }, 45000);
      show(name + ' <' + filename + '>', r);
    } catch (e) { console.log('EXC ' + name + ': ' + e.message); }
  }
  console.log('\nDL listing (mcp-test*):', JSON.stringify(myFiles()));
  for (const p of ['D:\\mcp-test-trav.bat', 'D:\\mcp-test-trav2.bat', 'D:\\Tool\\mcp-test-trav2.bat',
                   'C:\\mcp-test-abs.txt', 'C:\\Windows\\Temp\\mcp-test-t.bat', 'D:\\mcp-test-dot.'])
    if (fsExists(p)) note('TRAVERSAL', 'file escaped Downloads -> ' + p);
}

// ---------- PHASE C: Content-Disposition tricks ----------
if (PHASE === 'C' || PHASE === 'ALL') {
  console.log('\n--- PHASE C: Content-Disposition filename tricks (no filename arg) ---');
  for (const route of ['cd-backslash', 'cd-rfc5987', 'cd-abs', 'cd-subdir']) {
    try {
      const r = await call('download_file', { url: BASE2 + '/file/' + route }, 45000);
      show(route, r);
    } catch (e) { console.log('EXC ' + route + ': ' + e.message); }
  }
  console.log('DL listing (mcp-test*):', JSON.stringify(myFiles()));
  for (const p of ['D:\\mcp-test-cd-evil.bat', 'D:\\mcp-test-cd-evil2.bat', 'C:\\mcp-test-cd-abs.bat'])
    if (fsExists(p)) note('TRAVERSAL', 'CD filename escaped Downloads -> ' + p);
}

// ---------- PHASE D: behavior ----------
if (PHASE === 'D' || PHASE === 'ALL') {
  console.log('\n--- PHASE D: behavior ---');
  console.log('concurrent x3:');
  const rs = await Promise.all([
    call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-c1.txt' }),
    call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-c2.txt' }),
    call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-c3.txt' }),
  ]);
  rs.forEach((r, i) => show('conc-' + i, r));

  show('dup-1', await call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-dup.txt' }));
  show('dup-2(uniquify)', await call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-dup.txt' }));

  const before1 = fsExists(DL + '\\mcp-test-over.txt') ? fs.readFileSync(DL + '\\mcp-test-over.txt') : null;
  show('over-1', await call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-over.txt' }));
  show('over-2(overwrite,diff-body)', await call('download_file', { url: BASE2 + '/file/confuse2.bin', filename: 'mcp-test-over.txt', conflictAction: 'overwrite' }));
  const after1 = fsExists(DL + '\\mcp-test-over.txt') ? fs.readFileSync(DL + '\\mcp-test-over.txt') : null;
  console.log('  overwrite bytes changed:', !!(before1 && after1 && !before1.equals(after1)), '| now:', JSON.stringify(String(after1 || '').slice(0, 60)));

  console.log('interrupt test (killing server mid-download)...');
  const dlP = call('download_file', { url: BASE2 + '/file/huge', filename: 'mcp-test-huge.bin' }, 130000);
  await new Promise(r => setTimeout(r, 3000));
  try { await fetch(BASE2 + '/admin/die'); } catch {}
  const ri = await dlP;
  show('interrupted-huge', ri);
  // restart server for remaining tests
  const { spawn } = await import('node:child_process');
  const srv = spawn(process.execPath, [path.join(process.cwd(), 'adv-tests', 'adv-16-dl-server.mjs'), String(DL_PORT)], { detached: true, stdio: 'ignore' });
  srv.unref();
  await new Promise(r => setTimeout(r, 1500));

  show('zero-byte', await call('download_file', { url: BASE2 + '/file/zero.bin', filename: 'mcp-test-zero.bin' }));
  if (fsExists(DL + '\\mcp-test-zero.bin')) console.log('  zero.bin size:', fs.statSync(DL + '\\mcp-test-zero.bin').size);

  show('confuse-html-as-txt', await call('download_file', { url: BASE2 + '/file/confuse.txt' }));
  show('confuse2-octet', await call('download_file', { url: BASE2 + '/file/confuse2.bin', filename: 'mcp-test-confuse2.bin' }));

  show('redir-file', await call('download_file', { url: BASE2 + '/file/redir-file', filename: 'mcp-test-redirfile.txt' }));
  show('redir-data', await call('download_file', { url: BASE2 + '/file/redir-data', filename: 'mcp-test-redirdata.txt' }));
  show('redir-js', await call('download_file', { url: BASE2 + '/file/redir-js', filename: 'mcp-test-redirjs.txt' }));
  for (const f of myFiles()) {
    if (f.includes('redir')) {
      const p = path.join(DL, f);
      const head = fs.readFileSync(p).slice(0, 80).toString('latin1');
      console.log(`  ${f}: ${fs.statSync(p).size}B head=${JSON.stringify(head)}`);
      if (/win\.ini|\[fonts\]|for 16-bit/i.test(head)) note('SECURITY', 'redirect to file:// copied local file! ' + f);
    }
  }
  show('nolength', await call('download_file', { url: BASE2 + '/file/nolength', filename: 'mcp-test-nolength.bin' }));
}

// ---------- PHASE E: download history exposure ----------
if (PHASE === 'E' || PHASE === 'ALL') {
  console.log('\n--- PHASE E: list_downloads history exposure ---');
  const r = await call('list_downloads', { limit: 100 });
  const t = txt(r);
  try {
    const j = JSON.parse(t.slice(t.indexOf('{')));
    const items = j.downloads || [];
    console.log('history entries returned:', items.length);
    items.slice(0, 12).forEach(d => console.log(`  [${d.id}] ${d.state} ${d.danger || '-'} ${path.basename(d.filename || '')} <- ${(d.url || '').slice(0, 90)}`));
    const mine = items.filter(d => (d.filename || '').includes('mcp-test'));
    const foreign = items.filter(d => !(d.filename || '').includes('mcp-test'));
    if (foreign.length) note('INFO-DISCLOSURE', `list_downloads exposes ${foreign.length} pre-existing user downloads (filenames+URLs+times) to any MCP client`);
    console.log('  my-test-dls:', mine.length, 'foreign:', foreign.length);
    const danger = mine.filter(d => d.danger && d.danger !== 'safe');
    if (danger.length) console.log('  danger flags on mine:', JSON.stringify(danger.map(d => [path.basename(d.filename), d.danger])));
  } catch { console.log('list_downloads raw:', t.slice(0, 500)); }
  const rs2 = await call('list_downloads', { limit: 5, state: 'in_progress' });
  console.log('state-filter in_progress ->', txt(rs2).slice(0, 200));
}

// ---------- PHASE F: integrity ----------
if (PHASE === 'F' || PHASE === 'ALL') {
  console.log('\n--- PHASE F: byte integrity (sha256) ---');
  const hashRes = await fetch(BASE2 + '/file/big.sha256').then(r => r.text());
  const [bigSha, testSha] = hashRes.trim().split('\n').map(l => l.split(' ')[0]);
  show('testfile', await call('download_file', { url: BASE2 + '/file/testfile.txt', filename: 'mcp-test-hash.txt' }));
  if (fsExists(DL + '\\mcp-test-hash.txt')) {
    const h = sha256file(DL + '\\mcp-test-hash.txt');
    console.log(`  testfile sha match: ${h === testSha} (${h.slice(0, 16)}...)`);
  }
  show('big-50MB', await call('download_file', { url: BASE2 + '/file/big.bin', filename: 'mcp-test-big.bin' }));
  if (fsExists(DL + '\\mcp-test-big.bin')) {
    const h = sha256file(DL + '\\mcp-test-big.bin');
    const sz = fs.statSync(DL + '\\mcp-test-big.bin').size;
    console.log(`  big.bin size=${sz} sha match: ${h === bigSha}`);
    if (h !== bigSha) note('BUG', '50MB download corrupted: hash mismatch');
  }
}

// ---------- PHASE G: dangerous file types / Safe Browsing ----------
if (PHASE === 'G' || PHASE === 'ALL') {
  console.log('\n--- PHASE G: .exe/.bat download (Safe Browsing / danger flag) ---');
  show('fake.exe', await call('download_file', { url: BASE2 + '/file/fake.exe' }));
  show('fake.bat', await call('download_file', { url: BASE2 + '/file/fake.bat' }));
  const lr = await call('list_downloads', { limit: 20 });
  const t = txt(lr);
  try {
    const j = JSON.parse(t.slice(t.indexOf('{')));
    const mine = (j.downloads || []).filter(d => /mcp-test-fake\.(exe|bat)/.test(d.filename || ''));
    mine.forEach(d => console.log(`  ${path.basename(d.filename)}: state=${d.state} danger=${d.danger} exists=${d.exists}`));
    const completed = mine.filter(d => d.state === 'complete');
    if (completed.length) note('NOTE', `${completed.length} dangerous-type files downloaded without prompt; danger flag=${JSON.stringify(completed.map(d => d.danger))}`);
  } catch {}
}

console.log('\n=== DL dir mcp-test* leftovers:', JSON.stringify(myFiles()));
const cleaned = cleanupMine();
console.log('=== cleanup removed:', JSON.stringify(cleaned));
console.log('\n=== FINDINGS ===');
findings.forEach(f => console.log(f));
if (!findings.length) console.log('(none flagged)');
