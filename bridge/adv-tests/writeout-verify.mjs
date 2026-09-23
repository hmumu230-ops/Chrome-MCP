// Extracts the real writeOut/canonPath from ../index.js and attacks it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(bridgeDir, 'index.js'), 'utf8');

const grab = (name) => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`, 'm'))[0];
const consts = src.match(/const PROJECT_ROOT[\s\S]*?toLowerCase\(\)\);/)[0];
// eslint-disable-next-line no-eval
eval(`const __dirname = ${JSON.stringify(bridgeDir)};\n` + consts + '\n' + grab('canonPath') + '\n' + grab('writeOut') + '\nglobalThis.__writeOut = writeOut;');
const writeOut = globalThis.__writeOut;

// Fixtures: a junction INTO the repo and a hardlink TO index.js. Without
// these the two cases silently degrade to plain allowed writes.
try { fs.rmSync(path.join(os.tmpdir(), 'junc-test'), { recursive: true, force: true }); } catch {}
try { fs.rmSync('D:\\Tool\\hl-test.txt', { force: true }); } catch {}
const { execSync } = await import('node:child_process');
execSync(`mklink /J "${path.join(os.tmpdir(), 'junc-test')}" "${bridgeDir}"`, { shell: 'cmd.exe', stdio: 'ignore' });
// Hardlink fixture targets a junk file — the nlink check is identical, but a
// hypothetical write-through only corrupts junk, not index.js.
fs.writeFileSync('D:\\Tool\\hl-src.txt', 'original');
fs.linkSync('D:\\Tool\\hl-src.txt', 'D:\\Tool\\hl-test.txt');

const cases = [
  // [label, filePath, expectBlock]
  ['case-variant repo file', bridgeDir.toLowerCase().replace('d:\\', 'd:\\') + '\\index.js', true],
  ['case-variant ALLCAPS', bridgeDir.toUpperCase().replace('D:', 'D:') + '\\INDEX.JS', true],
  ['verbatim \\\\?\\', '\\\\?\\' + path.join(bridgeDir, 'index.js'), true],
  ['verbatim \\\\.\\', '\\\\.\\' + path.join(bridgeDir, 'index.js'), true],
  ['junction into repo', path.join(os.tmpdir(), 'junc-test', 'index.js'), true],
  ['hardlink outside repo', 'D:\\Tool\\hl-test.txt', true],
  ['.git hook new file', path.join(bridgeDir, '..', '.git', 'hooks', 'pre-commit'), true],
  ['.vscode tasks new file', path.join(bridgeDir, '..', '.vscode', 'tasks.json'), true],
  ['node_modules plant', path.join(bridgeDir, 'node_modules', 'pwn', 'index.js'), true],
  ['extension new file', path.join(bridgeDir, '..', 'extension', 'pwn.js'), true],
  ['repo root new file', path.join(bridgeDir, '..', 'pwn.bat'), true],
  ['startup .bat', path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'evil.bat'), true],
  ['windows dir', 'C:\\Windows\\Temp\\mcp-verify.txt', true],
  ['UNC', '\\\\127.0.0.1\\c$\\x.txt', true],
  ['ADS', path.join(os.tmpdir(), 'adv-x.txt:hidden'), true],
  ['trailing dot', path.join(os.tmpdir(), 'adv-x.txt.'), true],
  ['reserved NUL', 'NUL', true],
  ['reserved CONIN$', path.join(os.tmpdir(), 'conin$.txt'), true],
  ['reserved com0', path.join(os.tmpdir(), 'com0.txt'), true],
  ['legit temp write', path.join(os.tmpdir(), 'adv-verify-ok.txt'), false],
  ['legit downloads write', path.join(os.homedir(), 'Downloads', 'adv-verify-ok.txt'), false],
];

let pass = 0, fail = 0;
for (const [label, fp, expectBlock] of cases) {
  try {
    writeOut({ path: fp }, 'canary');
    if (expectBlock) {
      console.log(`FAIL (wrote): ${label} -> ${fp}`); fail++;
      // Remove via the WRITTEN path only — deleting a hardlink name is safe,
      // but never touch index.js through it.
      fs.rmSync(fp, { force: true });
    }
    else { console.log(`PASS wrote : ${label}`); pass++; fs.rmSync(fp, { force: true }); }
  } catch (e) {
    if (expectBlock) { console.log(`PASS block : ${label} — ${e.message}`); pass++; }
    else { console.log(`FAIL (blocked legit): ${label} — ${e.message}`); fail++; }
  }
}
console.log(`\n${pass} pass / ${fail} fail`);
// cleanup fixtures
try { fs.rmSync(path.join(os.tmpdir(), 'junc-test'), { recursive: true, force: true }); } catch {}
try { fs.rmSync('D:\\Tool\\hl-test.txt', { force: true }); } catch {}
try { fs.rmSync('D:\\Tool\\hl-src.txt', { force: true }); } catch {}
try { fs.rmSync(path.join(os.tmpdir(), 'adv-junc'), { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(os.tmpdir(), 'adv-junc2'), { recursive: true, force: true }); } catch {}
try { fs.rmSync('D:\\Tool\\adv-hl.txt', { force: true }); } catch {}
