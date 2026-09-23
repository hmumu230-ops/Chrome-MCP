// find tabs by url substring: node findtabs.js <substr>
const sub = process.argv[2] || '';
const s = require('fs').readFileSync('adv-tests/lp.json', 'utf8');
const ids = [...s.matchAll(/"pageId": (\d+)/g)].map(m => m[1]);
const urls = [...s.matchAll(/"url": "([^"]*)"/g)].map(m => m[1]);
// pair them loosely: iterate structuredContent items instead
const sc = s.match(/"structuredContent":\s*(\{[\s\S]*)/);
try {
  const j = JSON.parse(require('fs').readFileSync('adv-tests/lp.json', 'utf8').replace(/^[\s\S]*?"structuredContent": /, '').replace(/\n?\}?\s*$/, ''));
} catch {}
// simpler: regex pairs
const pairRe = /"pageId": (\d+),\s*\n\s*"title": "([^"]*)",\s*\n\s*"url": "([^"]*)",\s*\n\s*"active": (true|false),\s*\n\s*"windowId": \d+,\s*\n\s*"incognito": (true|false)/g;
let m;
while ((m = pairRe.exec(s))) {
  if (m[3].includes(sub)) console.log(m[1], '|', m[5] === 'true' ? 'INCOG' : 'normal', '|', m[3].slice(0, 75));
}
