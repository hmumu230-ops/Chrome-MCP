// adv-17-repro.mjs — bisect which traffic pattern kills the bridge.
// Prints health before/after each stage; supervisor log shows exits.
import { McpSession, health, sleep, brief, Tabs, startServer } from './adv-17-lib.mjs';

const srv = await startServer();
const U = 'http://127.0.0.1:' + srv.port + '/p';
const tabs = new Tabs();
const stage = async (name, fn) => {
  const h = await health();
  console.log(`\n=== ${name} | sessions=${h.sessions} ext=${h.extensionConnected}`);
  try { await fn(); } catch (e) { console.log('stage threw:', String(e).slice(0, 150)); }
  const h2 = await health();
  console.log(`=== ${name} done | sessions=${h2.sessions} ext=${h2.extensionConnected} ${h2.error || ''}`);
};

const s0 = new McpSession('repro');
await s0.init();
const pg = tabs.track(await s0.call('new_page', { url: U }));

// S1: 10 parallel inits only
const ss1 = [];
await stage('S1 10x parallel init', async () => {
  const r = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const x = new McpSession('r' + i);
    try { await x.init(); ss1.push(x); return 'ok'; } catch (e) { return 'fail:' + String(e).slice(0, 80); }
  }));
  console.log('inits:', JSON.stringify(r));
});
await sleep(2000); console.log('post-S1 health:', JSON.stringify(await health()));

// S2: 10 sessions x list_pages
await stage('S2 10sess x list_pages', async () => {
  const r = await Promise.all(ss1.map(x => x.call('list_pages', {})));
  console.log('list:', r.map(x => x.ok ? 'ok' : brief(x)).join(','));
});
await sleep(2000); console.log('post-S2 health:', JSON.stringify(await health()));

// S3: 10 sessions x new_page (parallel across sessions)
await stage('S3 10sess x new_page', async () => {
  const r = await Promise.all(ss1.map(x => x.call('new_page', { url: U, background: true })));
  r.forEach(x => tabs.track(x));
  console.log('new:', r.map(x => x.ok ? 'ok' : brief(x)).join(','));
});
await sleep(2000); console.log('post-S3 health:', JSON.stringify(await health()));

// S4: 10 sessions x evaluate on own page
await stage('S4 10sess x eval', async () => {
  const pages = [...tabs.mine].slice(-10);
  const r = await Promise.all(ss1.map((x, i) => x.call('evaluate_script', { pageId: pages[i], function: `() => 'e${i}'` })));
  console.log('eval:', r.map(x => x.ok ? 'ok' : brief(x)).join(','));
});
await sleep(2000); console.log('post-S4 health:', JSON.stringify(await health()));

// S5: same thing but SEQUENTIAL control group — 10 sequential new_page
await stage('S5 10x sequential new_page', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await s0.call('new_page', { url: U, background: true });
    tabs.track(r);
  }
  console.log('seq new_page done');
});
await sleep(2000); console.log('post-S5 health:', JSON.stringify(await health()));

// cleanup
await tabs.closeAll(s0);
await Promise.all(ss1.map(x => x.close()));
await s0.close();
srv.close();
console.log('\ndone. final health:', JSON.stringify(await health()));
