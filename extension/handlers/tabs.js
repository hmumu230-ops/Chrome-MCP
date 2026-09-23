// Tab / page management tools — chrome.tabs + chrome.windows APIs.
import { ensureDebugger, cdp } from './cdp.js';

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); }
  catch { throw new Error('no such page/tab: ' + tabId); }
}

// Navigation allowlist. file:// is a confirmed LFI (the tab loads local files
// and page tools read their contents back out); chrome:/view-source:/blob:/
// data: are either unscriptable or execute inline content. WHATWG strips
// tab/LF/CR inside the scheme ("java\tscript:" parses as javascript:), so
// normalize before matching or the check is trivially evaded.
function checkNavUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('url required');
  const u = url.trim().replace(/[\t\n\r]/g, '');
  if (u === 'about:blank') return u;
  if (!/^https?:\/\//i.test(u)) throw new Error('disallowed URL (http/https only): ' + u.slice(0, 40));
  return u;
}

export const tabTools = {
  async list_pages() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({
      pageId: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
      incognito: t.incognito,
    }));
  },

  async new_page({ url, background, isolatedContext }) {
    if (isolatedContext) {
      const allowed = await chrome.extension.isAllowedIncognitoAccess();
      if (!allowed) throw new Error('extension is not allowed in incognito — enable "Allow in incognito" in chrome://extensions for this extension');
      const win = await chrome.windows.create({ url: url ? checkNavUrl(url) : 'about:blank', incognito: true, focused: !background });
      return { pageId: win.tabs[0].id, url: win.tabs[0].pendingUrl || win.tabs[0].url, isolatedContext };
    }
    const tab = await chrome.tabs.create({ url: url ? checkNavUrl(url) : 'about:blank', active: !background });
    return { pageId: tab.id, url: tab.pendingUrl || tab.url };
  },

  async close_page({ pageId }) {
    if (!Number.isInteger(pageId)) throw new Error('pageId must be an integer tab id');
    // A beforeunload prompt on a dirty+activated tab pends tabs.remove
    // forever — race it, then dismiss the prompt via CDP and retry.
    const gone = await Promise.race([
      chrome.tabs.remove(pageId).then(() => true),
      new Promise(r => setTimeout(() => r(false), 4000)),
    ]);
    if (gone) return { closed: pageId };
    try {
      await ensureDebugger(pageId, ['Page']);
      await cdp(pageId, 'Page.handleJavaScriptDialog', { accept: true }, 5000);
    } catch {}
    await chrome.tabs.remove(pageId);
    return { closed: pageId };
  },

  async select_page({ pageId, bringToFront }) {
    const tab = await getTab(pageId);
    await chrome.tabs.update(pageId, { active: true });
    if (bringToFront) await chrome.windows.update(tab.windowId, { focused: true });
    return { pageId, selected: true };
  },

  async navigate_page({ pageId, type, url, ignoreCache }) {
    await getTab(pageId);
    switch (type || 'url') {
      case 'url':
        await chrome.tabs.update(pageId, { url: checkNavUrl(url) });
        break;
      case 'back':
      case 'forward': {
        // chrome.tabs.goBack/goForward is unreliable for extension-initiated
        // navigations ("Cannot find a next page in history"). Drive the page's
        // own session history first; restricted pages fall back to CDP's
        // navigation-history list (what DevTools' back button uses).
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: pageId },
            func: (d) => {
              try {
                // navigation.canGoBack only sees the same-origin contiguous run —
                // cross-origin entries (e.g. after a link click) live outside it.
                const nav = window.navigation;
                if (nav && 'canGoBack' in nav) {
                  const ok = d === 'back' ? nav.canGoBack : nav.canGoForward;
                  if (!ok) return { __ok: true, v: { moved: 'maybe-cdp' } };
                }
                history[d]();
                return { __ok: true, v: { moved: true } };
              } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
            },
            args: [type],
          });
          const res = r && r.result;
          if (res && res.__ok === false) throw new Error(res.err || 'page-side error');
          if (!res) throw new Error('no result from page');
          if (res.v && res.v.moved === true) break;   // same-origin move done
          // moved==='maybe-cdp': cross-origin history may still exist → CDP.
        } catch (e) {
          if (!/no result from page/.test(String(e && e.message))) { /* fall through to CDP */ }
        }
        await ensureDebugger(pageId, ['Page']);
        const { entries, currentIndex } = await cdp(pageId, 'Page.getNavigationHistory');
        const target = entries[currentIndex + (type === 'back' ? -1 : 1)];
        if (!target) throw new Error('no ' + type + ' page in history');
        await cdp(pageId, 'Page.navigateToHistoryEntry', { entryId: target.id });
        break;
      }
      case 'reload': await chrome.tabs.reload(pageId, { bypassCache: !!ignoreCache }); break;
      default: throw new Error('unknown navigation type: ' + type);
    }
    // best-effort wait for load
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      const lis = (id, info) => {
        if (id === pageId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(lis); clearTimeout(timer); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(lis);
    });
    const t = await chrome.tabs.get(pageId).catch(() => null);
    return { pageId, url: t && t.url, title: t && t.title };
  },

  async resize_page({ pageId, width, height }) {
    const tab = await getTab(pageId);
    await chrome.windows.update(tab.windowId, { width: Math.round(width), height: Math.round(height) });
    return { pageId, width, height };
  },

  async wait_for({ pageId, text, textGone, time, timeout, ...rest }) {
    await getTab(pageId); // fail fast on closed/nonexistent tabs
    // Unknown params must not be silently swallowed — {selector:'#x'} used to
    // return {waited:0} looking like a successful wait when nothing waited.
    const unknown = Object.keys(rest);
    if (unknown.length) throw new Error('unknown wait_for params: ' + unknown.join(', ') + ' (supported: text, textGone, time, timeout)');
    if (!text && !textGone && !time) throw new Error('wait_for needs at least one condition: text, textGone, or time');
    if (time) { await new Promise(r => setTimeout(r, Math.min(time, 60000))); }
    if (!text && !textGone) return { waited: time || 0 };
    const deadline = Date.now() + Math.min(Number(timeout) || 15000, 120000);
    let lastErr = null, errStreak = 0;
    while (Date.now() < deadline) {
      try {
        const frames = await chrome.scripting.executeScript({
          target: { tabId: pageId, allFrames: true },
          func: (texts, gone) => {
            const body = document.body ? document.body.innerText : '';
            const has = (arr) => !arr || !arr.length || arr.some(t => body.includes(t));
            const missing = (arr) => !arr || !arr.length || arr.every(t => !body.includes(t));
            return has(texts) && missing(gone);
          },
          args: [text || null, textGone || null],
        });
        errStreak = 0;
        // Text in any frame counts (matches chrome-devtools-mcp page-wide semantics).
        if (frames.some(r => r && r.result)) return { pageId, found: true };
      } catch (e) {
        // Injection keeps failing (dead tab, chrome:// page) → don't burn the
        // whole timeout on an impossible wait.
        lastErr = e;
        if (++errStreak >= 3) throw new Error('cannot poll page: ' + (e && e.message || e));
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('timeout waiting: ' + JSON.stringify({ text, textGone }));
  },
};
