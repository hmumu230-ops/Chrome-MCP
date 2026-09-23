// adv-16b — Transport size caps.
//  a) evaluate_script return values: 1MB, 5MB, 10MB (constraint: <=10MB).
//     Whatever survives tells us whether a cap exists in-band.
//  b) REQUEST side: bridge readBody cap is MAX_BODY=4MiB — verify a >4MB
//     args payload gets HTTP 413, and just-under passes.
// Run: node adv-16b-evalsize.mjs
import { init, call, myTab, closeTab, rpc, fmtBytes, line } from './adv16-lib.mjs';

await init('adv-16b');
console.log('== adv-16b: transport size caps ==');

const pageId = await myTab('-evalsize');
if (!pageId) { console.log('FATAL: cannot open tab'); process.exit(1); }
console.log('tab', pageId);

// a) return-size ladder (page builds the string so the REQUEST stays small)
for (const mb of [1, 5, 10]) {
  const n = mb * 1024 * 1024;
  const t0 = performance.now();
  const r = await call('evaluate_script', {
    pageId,
    function: `() => 'x'.repeat(${n})`,
  });
  const dt = Math.round(performance.now() - t0);
  if (r.ok) {
    const got = r.data && typeof r.data.result === 'string' ? r.data.result.length : -1;
    line(`eval return ${mb}MB`, got === n, `got=${got} chars, httpResp=${fmtBytes(r.bytes)}, ${dt}ms`);
  } else {
    line(`eval return ${mb}MB`, false, `${r.err} | httpResp=${fmtBytes(r.bytes)}, ${dt}ms`);
  }
}

// a2) object result with 10MB across fields (structuredContent path)
{
  const n = 10 * 1024 * 1024;
  const t0 = performance.now();
  const r = await call('evaluate_script', {
    pageId,
    function: `() => ({a:'x'.repeat(${n >> 1}), b:'y'.repeat(${n >> 1})})`,
  });
  const dt = Math.round(performance.now() - t0);
  const got = r.ok && r.data && r.data.result ? (r.data.result.a.length + r.data.result.b.length) : -1;
  line('eval return 10MB object', r.ok && got === n, `got=${got}, httpResp=${fmtBytes(r.bytes)}, ${dt}ms${r.ok ? '' : ' ERR ' + r.err}`);
}

// b) request-side cap: MAX_BODY = 4MiB. Oversized function arg -> expect 413.
//    Build the payload client-side; tool call itself will fail at HTTP layer.
{
  // ~4.2MB JSON body (function source padded with a comment)
  const pad = ' '.repeat(4.3 * 1024 * 1024);
  const t0 = performance.now();
  const r = await rpc({ jsonrpc: '2.0', id: 9990, method: 'tools/call', params: { name: 'evaluate_script', arguments: { pageId, function: `() => 1 /*${pad}*/` } } });
  const dt = Math.round(performance.now() - t0);
  line('4.3MB request rejected 413', r.status === 413, `status=${r.status} body=${(r.rawText || '').slice(0, 60)} ${dt}ms`);
}
{
  // just under the cap — must succeed (pad to ~3.9MB total body)
  const pad = ' '.repeat(3.8 * 1024 * 1024);
  const t0 = performance.now();
  const r = await call('evaluate_script', { pageId, function: `() => 42 /*${pad}*/` });
  const dt = Math.round(performance.now() - t0);
  line('3.9MB request accepted', r.ok && r.data && r.data.result === 42, `${dt}ms ${r.ok ? '' : r.err}`);
}

await closeTab(pageId);
console.log('done — tab closed');
