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
        const { data } = await runInPage(pageId, (p) => window.__mcp.snapshot(p), [prefix], f.frameId);
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

  async take_screenshot({ pageId, format, quality, uid, fullPage }) {
    const fmt = format || 'png';
    // Element or full-page shots go through CDP for clip control.
    if (uid || fullPage) {
      await ensureLib(pageId);
      await ensureDebugger(pageId, ['Page']);
      let clip;
      if (uid) {
        const { data: box } = await runInPage(pageId, (u) => {
          const el = window.__mcp.find(u);
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
        }, [uid], checkUid(pageId, uid)).catch(() => ({ data: null }));
        if (!box) throw new Error('element not found: ' + uid);
        clip = box;
      } else {
        const { cssContentSize } = await cdp(pageId, 'Page.getLayoutMetrics', {});
        clip = { x: 0, y: 0, scale: 1, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16384) };
      }
      const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality, clip, captureBeyondViewport: !!fullPage });
      return { image: { base64: data, mimeType: 'image/' + fmt } };
    }
    const tab = await chrome.tabs.get(pageId);
    // captureVisibleTab shoots the window's ACTIVE tab — for background tabs
    // (and webp, which it doesn't support) go through CDP instead.
    if (!tab.active || fmt === 'webp') {
      await ensureDebugger(pageId, ['Page']);
      const { data } = await cdp(pageId, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'png' ? undefined : quality });
      return { image: { base64: data, mimeType: 'image/' + fmt } };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: fmt === 'jpeg' ? 'jpeg' : 'png', quality });
    return { image: { base64: dataUrl.split(',')[1], mimeType: fmt === 'jpeg' ? 'image/jpeg' : 'image/png' } };
  },

  async evaluate_script({ pageId, function: fnSrc, args, frameId, dialogAction, filePath }) {
    // dialogAction handling requires debugger (page dialogs are native).
    if (dialogAction !== undefined) {
      await ensureDebugger(pageId, ['Page']);
      setPendingDialogAction(pageId, dialogAction);
    }
    // Element uids live in the frame that snapshotted them.
    const fid = frameId ?? (args && args.length ? checkUid(pageId, args[0]) : undefined);
    if (args && args.length) await ensureLib(pageId);
    const { data } = await runInPage(pageId, (src, uids) => {
      const fn = eval('(' + src + ')');
      const els = (uids || []).map(u => window.__mcp && window.__mcp.find(u));
      return fn(...els);
    }, [fnSrc, args], fid);
    if (filePath) return { file: { path: filePath, content: JSON.stringify(data) }, summary: 'script output written to file' };
    return { result: data };
  },
};
