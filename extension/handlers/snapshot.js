// Snapshot / screenshot / script evaluation tools.
import { ensureLib, runInPage, setFrameMap, frameFor, checkUid } from './util.js';
import { ensureDebugger, cdp, setPendingDialogAction } from './cdp.js';

export const snapshotTools = {
  async take_snapshot({ pageId, verbose }) {
    // verbose → full AX tree via CDP; default → injected DOM snapshot (all frames).
    if (verbose && await ensureDebugger(pageId, ['Accessibility'])) {
      const { nodes } = await cdp(pageId, 'Accessibility.getFullAXTree', {});
      const lines = nodes
        .filter(n => !n.ignored && n.role && n.role.value !== 'none' && n.role.value !== 'generic')
        .map(n => `${n.role.value}: "${(n.name && n.name.value || '').slice(0, 100)}"`);
      return { mode: 'axtree', lines };
    }
    await ensureLib(pageId);

    let frames = [{ frameId: 0 }];
    try { frames = await chrome.webNavigation.getAllFrames({ tabId: pageId }); } catch {}

    const uidMap = new Map();
    const lines = [];
    let title, url;
    for (const f of frames) {
      const prefix = f.frameId === 0 ? '' : 'f' + f.frameId;
      try {
        const { data } = await runInPage(pageId, (p) => window.__mcp.tryCall('snapshot', p), [prefix], f.frameId);
        if (f.frameId === 0) { title = data.title; url = data.url; }
        for (const u of data.uids || []) uidMap.set(u, f.frameId);
        if (data.lines.length === 0) continue;
        if (f.frameId !== 0) lines.push(`--- iframe frameId=${f.frameId} url=${data.url || f.url} ---`);
        lines.push(...data.lines);
      } catch (e) {
        if (f.frameId !== 0) lines.push(`--- iframe frameId=${f.frameId} url=${f.url} (inaccessible) ---`);
      }
    }
    setFrameMap(pageId, uidMap);
    return { mode: 'dom', url, title, lines };
  },

  async take_screenshot({ pageId, format, quality, uid, fullPage, filePath }) {
    const fmt = format || 'png';
    const shot = (base64, mime) => filePath
      ? { file: { path: filePath, content: base64, base64: true }, saved: filePath }
      : { image: { base64, mimeType: mime } };
    // Element or full-page shots go through CDP for clip control.
    if (uid || fullPage) {
      await ensureLib(pageId);
      await ensureDebugger(pageId, ['Page']);
      let clip;
      if (uid) {
        const { data: box } = await runInPage(pageId, (u) => window.__mcp.tryCall('box', u), [uid], checkUid(pageId, uid)).catch(() => ({ data: null }));
        if (!box) throw new Error('element not found or not visible: ' + uid);
        // clip is interpreted in DOCUMENT coords — box.x/y are viewport coords.
        clip = { x: box.docX ?? box.x, y: box.docY ?? box.y, width: box.width, height: box.height, scale: 1 };
      } else {
        const { cssContentSize } = await cdp(pageId, 'Page.getLayoutMetrics', {});
        clip = { x: 0, y: 0, scale: 1, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16384) };
        // Chrome caps captures at 16384px — tell the caller content was cut.
        if (cssContentSize.height > 16384) {
          var truncated = true;
        }
      }
      const cap = (extra, timeoutMs) => cdp(pageId, 'Page.captureScreenshot', {
        format: fmt, quality: fmt === 'png' ? undefined : quality, clip,
        captureBeyondViewport: !!fullPage, ...extra,
      }, timeoutMs);
      const fin = (data) => ({ ...shot(data, 'image/' + fmt), ...(truncated ? { truncated: true, note: 'page exceeds 16384px capture limit — bottom cut off' } : {}) });
      try {
        const { data } = await cap({}, 12000);
        return fin(data);
      } catch (e) {
        if (!/CDP timeout/.test(String(e && e.message || e))) throw e;
        // First capture on a background/occluded tab stalls while Chrome warms
        // the compositor — the identical retry usually succeeds fast.
        try {
          const { data } = await cap({}, 12000);
          return fin(data);
        } catch (e1) {
          try {
            const { data } = await cap({ fromSurface: false }, 12000);
            return fin(data);
          } catch (e2) {
            if (!fullPage || !/CDP timeout/.test(String(e2 && e2.message || e2))) {
              // Don't mask the primary failure behind the fallback's error.
              throw new Error('screenshot failed: ' + (e && e.message || e) + '; retries: ' + (e2 && e2.message || e2));
            }
          }
        }
        // Last resort for fullPage: grow viewport to content height, shoot, restore.
        await cdp(pageId, 'Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(clip.width), height: Math.ceil(clip.height),
          deviceScaleFactor: 1, mobile: false,
        });
        try {
          const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality, fromSurface: false });
          return shot(data, 'image/' + fmt);
        } finally {
          await cdp(pageId, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
        }
      }
    }
    const tab = await chrome.tabs.get(pageId);
    // captureVisibleTab shoots the window's ACTIVE tab — for background tabs
    // (and webp, which it doesn't support) go through CDP instead.
    if (!tab.active || fmt === 'webp') {
      await ensureDebugger(pageId, ['Page']);
      try {
        const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality }, 12000);
        return shot(data, 'image/' + fmt);
      } catch (e) {
        if (!/CDP timeout/.test(String(e && e.message || e))) throw e;
        // First capture warms the occluded compositor — same-params retry
        // usually succeeds; fromSurface:false is the last resort (unsupported
        // on some headed builds, kept for platforms where it works).
        try {
          const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality }, 12000);
          return shot(data, 'image/' + fmt);
        } catch (e1) {
          try {
            const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality, fromSurface: false }, 12000);
            return shot(data, 'image/' + fmt);
          } catch (e2) {
            throw new Error('screenshot failed: ' + (e && e.message || e) + '; retries: ' + (e2 && e2.message || e2));
          }
        }
      }
    }
    try {
      const dataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(tab.windowId, { format: fmt === 'jpeg' ? 'jpeg' : 'png', quality }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('captureVisibleTab timeout')), 20000)),
      ]);
      return shot(dataUrl.split(',')[1], fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
    } catch (e) {
      // captureVisibleTab can hang on occluded/minimized windows — retry via
      // the debugger (compositor warmup), then the surface-less path.
      await ensureDebugger(pageId, ['Page']);
      try {
        const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality }, 12000);
        return shot(data, 'image/' + fmt);
      } catch {
        const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality, fromSurface: false }, 12000);
        return shot(data, 'image/' + fmt);
      }
    }
  },

  async evaluate_script({ pageId, function: fnSrc, args, frameId, dialogAction, filePath }) {
    // dialogAction handling requires debugger (page dialogs are native).
    if (dialogAction !== undefined) {
      await ensureDebugger(pageId, ['Page']);
      setPendingDialogAction(pageId, dialogAction);
    }
    // Element uids live in the frame that snapshotted them.
    const fid = frameId ?? (args && args.length ? checkUid(pageId, args[0]) : undefined);
    // Run in the MAIN world: the page's real JS context and the page's own CSP
    // (isolated worlds inherit the extension CSP, which forbids eval entirely).
    let data;
    try {
      const target = fid !== undefined ? { tabId: pageId, frameIds: [fid] } : { tabId: pageId };
      const [r] = await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: (src, uids) => {
          // Lossy-but-honest serializer: BigInt/function/symbol/circular/DOM
          // values all get string-ish forms instead of silently becoming {}.
          const norm = (v) => {
            if (v === undefined) return null;
            const seen = new WeakSet();
            try {
              return JSON.parse(JSON.stringify(v, (k, x) => {
                if (typeof x === 'bigint') return x.toString() + 'n';
                if (typeof x === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
                if (typeof x === 'symbol') return String(x);
                if (x && typeof x === 'object') {
                  if (seen.has(x)) return '[Circular]';
                  seen.add(x);
                  if (x instanceof Element) return '<' + x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + '>';
                }
                return x;
              }));
            } catch { try { return String(v); } catch { return null; } }
          };
          try {
            const fn = (0, eval)('(' + src + ')');
            const els = (uids || []).map(u => {
              const safe = String(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              return document.querySelector('[data-mcp-uid="' + safe + '"]');
            });
            // executeScript awaits a top-level promise → async functions get
            // real results (previously a pending Promise serialized to {}).
            return Promise.resolve()
              .then(() => fn(...els))
              .then(v => ({ __ok: true, v: norm(v) }),
                    e => ({ __ok: false, err: String(e && e.message || e) }));
          } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
        },
        args: [fnSrc, (args && args.length ? args : null)],
      });
      if (r && r.error) throw new Error(String(r.error.message || r.error));
      if (!r) throw new Error('no result from page');
      const out = r.result;
      if (out && out.__ok === true) data = out.v;
      else if (out && out.__ok === false) throw new Error(out.err || 'page-side error');
      else data = out;
    } catch (e) {
      // Page CSP blocks eval (strict sites like github.com) — CDP evaluation
      // bypasses page CSP entirely, at the cost of attaching the debugger.
      if (!/unsafe-eval|Content Security Policy|EvalError/i.test(String(e && e.message || e))) throw e;
      await ensureDebugger(pageId, ['Runtime']);
      // uids go in as a JSON data literal — raw interpolation let crafted uids
      // break out of the selector string and inject code into the expression.
      const uidsJson = JSON.stringify(args || []);
      const expr = '(() => { const all=[...document.querySelectorAll("[data-mcp-uid]")]; const els=' + uidsJson +
        '.map(u=>all.find(e=>e.getAttribute("data-mcp-uid")===String(u))||null); return (' + fnSrc + ').apply(null, els); })()';
      const res = await cdp(pageId, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        throw new Error(ex.text + (ex.exception && ex.exception.description ? ' ' + ex.exception.description : ''));
      }
      data = res.result ? res.result.value : undefined;
    }
    if (filePath) return { file: { path: filePath, content: JSON.stringify(data) }, summary: 'script output written to file' };
    return { result: data };
  },
};
