// Shared helpers for running code inside tabs.

// uid -> frameId registry, per tab. Populated by take_snapshot; consulted by
// element tools so uids inside (same- or cross-origin) iframes work.
const frameMaps = new Map(); // tabId -> Map<uid, frameId>

export function setFrameMap(tabId, map) { frameMaps.set(tabId, map); }
export function frameFor(tabId, uid) {
  return (frameMaps.get(tabId) && frameMaps.get(tabId).get(uid)) ?? undefined;
}
export function clearFrameMap(tabId) { frameMaps.delete(tabId); }

// Staleness guard: if a snapshot was taken and the uid isn't in it, the uid
// predates the latest snapshot — fail loudly instead of clicking the wrong node.
export function checkUid(tabId, uid) {
  const m = frameMaps.get(tabId);
  if (m && !m.has(uid)) throw new Error(`stale uid "${uid}" — call take_snapshot for a fresh snapshot`);
  return frameFor(tabId, uid);
}

// Wait for the tab to settle after a mutating action (simplified
// waitForEventsAfterAction): poll load status up to 3s + small quiet window.
export async function settle(tabId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  await new Promise(r => setTimeout(r, 100));
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (!t || t.status !== 'loading') break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 150));
}

// Inject the DOM helper library into every frame of the tab.
// chrome.scripting with allFrames reaches cross-origin iframes too
// (host_permissions <all_urls> is set in the manifest).
export async function ensureLib(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['inject/dom.js'],
  });
}

// chrome.scripting rejects non-JSON-serializable args (undefined, functions).
// Deep-clean via JSON round-trip: undefined-in-array -> null, undefined
// object keys dropped — matches what the API would do anyway.
function cleanArgs(args) {
  return (args || []).map(a => (a === undefined ? null : (a !== null && typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : a)));
}

// Injected functions MUST NOT throw: Chrome drops the exception and returns
// result:null (crbug 1271527 — InjectionResult.error is unimplemented).
// Page fns return {__ok:true,v} / {__ok:false,err}; unwrap surfaces errors.
function unwrap(d) {
  if (d && typeof d === 'object' && d.__ok === true) return d.v;
  if (d && typeof d === 'object' && d.__ok === false) throw new Error(d.err || 'page-side error');
  if (d === null || d === undefined) throw new Error('injected function returned nothing (it may have thrown)');
  return d;
}
function unwrapForFrame(d) {
  if (d && typeof d === 'object' && d.__ok === true) return { result: d.v };
  if (d && typeof d === 'object' && d.__ok === false) return { error: d.err || 'page-side error' };
  return { result: d };
}

// Run `func` in one frame (default: main frame, isolated world).
export async function runInPage(tabId, func, args = [], frameId) {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
  const [r] = await chrome.scripting.executeScript({ target, func, args: cleanArgs(args), world: 'ISOLATED' });
  if (!r) throw new Error('no result from page');
  if (r.error) throw new Error(String(r.error.message || r.error));
  return { data: unwrap(r.result), frameId: r.frameId };
}

// Run `func` in every frame; returns [{frameId, result|error}].
export async function runInAllFrames(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func, args: cleanArgs(args), world: 'ISOLATED',
  });
  return res.map(r => {
    const u = unwrapForFrame(r.result);
    return { frameId: r.frameId, result: u.result, error: u.error || (r.error ? String(r.error.message || r.error) : undefined) };
  });
}
