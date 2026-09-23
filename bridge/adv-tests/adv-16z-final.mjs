// adv-16z-final — final sweep: close #adv16 tabs, then DELETE our session
// so it doesn't hold one of the 50 slots for the 45min TTL.
import { init, call, sweepMarked, status, BASE } from './adv16-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sid = await init('adv-16z-final').catch(e => { console.log('init failed:', e.message); return null; });
if (sid) {
  const r = await sweepMarked();
  console.log(`marked tabs found=${r.found} closed=${r.closed}`);
  const pages = await call('list_pages', {});
  const all = (pages.data && (pages.data.items || pages.data)) || [];
  const mine = all.filter(p => String(p.url || '').includes('#adv16'));
  console.log(`remaining #adv16 tabs: ${mine.length}`);
  try {
    const d = await fetch(BASE, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    console.log('session DELETE:', d.status);
  } catch (e) { console.log('DELETE failed:', e.message); }
  try { fs.rmSync(path.join(os.tmpdir(), 'adv16-sid.txt'), { force: true }); } catch {}
  const st = await status();
  console.log(`final: sessions=${st.sessions} ext=${st.extensionConnected}`);
}
console.log('cleanup done');
