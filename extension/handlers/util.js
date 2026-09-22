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

// Run `func` in one frame (default: main frame, isolated world).
export async function runInPage(tabId, func, args = [], frameId) {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
  const [r] = await chrome.scripting.executeScript({ target, func, args, world: 'ISOLATED' });
  if (!r) throw new Error('no result from page');
  if (r.error) throw new Error(String(r.error.message || r.error));
  return { data: r.result, frameId: r.frameId };
}

// Run `func` in every frame; returns [{frameId, result|error}].
export async function runInAllFrames(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func, args, world: 'ISOLATED',
  });
  return res.map(r => ({ frameId: r.frameId, result: r.result, error: r.error ? String(r.error.message || r.error) : undefined }));
}
