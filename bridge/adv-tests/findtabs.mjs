// find tabs by url substring: node findtabs.mjs <substr>
import fs from 'node:fs';
const sub = process.argv[2] ?? '';
const s = fs.readFileSync('adv-tests/lp.json', 'utf8');
const pairRe = /"pageId": (\d+),\s*\n\s*"title": "([^"]*)",\s*\n\s*"url": "([^"]*)",\s*\n\s*"active": (true|false),\s*\n\s*"windowId": \d+,\s*\n\s*"incognito": (true|false)/g;
let m;
while ((m = pairRe.exec(s))) {
  if (m[3].includes(sub)) console.log(m[1], '|', m[5] === 'true' ? 'INCOG' : 'normal', '|', m[3].slice(0, 75));
}
