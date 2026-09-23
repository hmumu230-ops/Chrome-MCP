// adv-16h — verify: does take_screenshot->filePath on an existing repo file
// really refuse the write while claiming 'saved' in structuredContent?
import { init, call, myTab, closeTab } from './adv16-lib.mjs';
await init('adv-16h');
const t = await call('new_page', { url: 'http://127.0.0.1:7890/#adv16-vsaved', background: true });
if (!t.ok) { console.log('new_page failed:', t.err); process.exit(1); }
const pageId = t.data.pageId;
const r = await call('take_screenshot', { pageId, filePath: 'D:/Tool/chrome-mcp/bridge/index.js', format: 'png' });
console.log('ok=', r.ok, 'err=', r.err || '');
console.log('--- content[0].text ---');
console.log((r.raw && r.raw.content && r.raw.content[0] && r.raw.content[0].text || '').slice(0, 400));
console.log('--- structuredContent ---');
console.log(JSON.stringify(r.raw && r.raw.structuredContent));
await closeTab(pageId);
