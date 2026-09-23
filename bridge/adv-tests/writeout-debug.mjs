import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(bridgeDir, 'index.js'), 'utf8');
const grab = (n) => src.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n}`, 'm'))[0];
const consts = src.match(/const PROJECT_ROOT[\s\S]*?toLowerCase\(\)\);/)[0];
eval(`const __dirname = ${JSON.stringify(bridgeDir)};\n` + consts + '\n' + grab('canonPath') + '\n' + grab('writeOut') +
  '\nglobalThis.w=writeOut;globalThis.c=canonPath;globalThis.d=DENY_ROOTS;');
const j = path.join(os.tmpdir(), 'junc-test', 'index.js');
console.log('target:', j);
console.log('canon :', globalThis.c(j));
console.log('roots :', globalThis.d);
try { globalThis.w({ path: j }, 'x'); console.log('=> WROTE (BAD)'); } catch (e) { console.log('=> BLOCKED:', e.message); }
try { globalThis.w({ path: 'D:\\Tool\\hl-test.txt' }, 'x'); console.log('=> WROTE hl (BAD)'); } catch (e) { console.log('=> BLOCKED hl:', e.message); }
