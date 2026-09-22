// Interaction tools — injected DOM library + scripting API.
// Element uids may live in iframes; frameFor() routes calls to the right frame.
import { ensureLib, runInPage, runInAllFrames, frameFor, checkUid } from './util.js';
import { cdp, ensureDebugger, getSession } from './cdp.js';

async function snapshotMaybe(pageId, include) {
  if (!include) return undefined;
  const { take_snapshot } = await import('./snapshot.js').then(m => m.snapshotTools);
  return take_snapshot({ pageId });
}

// Run fn(u, ...extra) in the frame that owns uid. If the mapped frame no
// longer holds the element (iframe navigated after snapshot), retry in all
// frames before giving up.
async function inFrameOf(pageId, uid, fn, extra = []) {
  const fid = checkUid(pageId, uid);
  try {
    return await runInPage(pageId, fn, [uid, ...extra], fid);
  } catch (e) {
    if (!/not found|detached/i.test(String(e && e.message || e)) || fid === undefined) throw e;
    const res = await runInAllFrames(pageId, fn, [uid, ...extra]);
    const hit = res.find(r => !r.error);
    if (!hit) throw e;
    return { data: hit.result, frameId: hit.frameId };
  }
}

export const interactTools = {
  async click({ pageId, uid, dblClick, includeSnapshot }) {
    await ensureLib(pageId);
    // Trusted path: if the debugger is attached and the tab is visible, click
    // via CDP Input (isTrusted) — survives React root delegation and
    // isTrusted checks. Falls back to synthetic events silently.
    const tab = await chrome.tabs.get(pageId).catch(() => null);
    if (getSession(pageId) && tab && tab.active) {
      try {
        const { data: pt } = await inFrameOf(pageId, uid, (u) => {
          const el = window.__mcp.find(u);
          if (!el) throw new Error('element not found: ' + u);
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        for (let i = 0; i < (dblClick ? 2 : 1); i++) {
          await cdp(pageId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: i + 1 });
          await cdp(pageId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: i + 1 });
        }
        return { clicked: uid, via: 'cdp', snapshot: await snapshotMaybe(pageId, includeSnapshot) };
      } catch {}
    }
    await inFrameOf(pageId, uid, (u, d) => window.__mcp.click(u, d), [!!dblClick]);
    return { clicked: uid, via: 'synthetic', snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async hover({ pageId, uid, includeSnapshot }) {
    await ensureLib(pageId);
    await inFrameOf(pageId, uid, (u) => window.__mcp.hover(u));
    return { hovered: uid, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async drag({ pageId, from_uid, to_uid, includeSnapshot }) {
    await ensureLib(pageId);
    // Cross-frame drag is not supported; both uids must be in one frame.
    await inFrameOf(pageId, from_uid, (a, b) => window.__mcp.dragTo(a, b), [to_uid]);
    return { dragged: from_uid, onto: to_uid, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async fill({ pageId, uid, value, includeSnapshot }) {
    await ensureLib(pageId);
    await inFrameOf(pageId, uid, (u, v) => window.__mcp.fill(u, v), [String(value)]);
    return { filled: uid, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async fill_form({ pageId, elements, includeSnapshot }) {
    await ensureLib(pageId);
    // Group elements by owning frame, then fill each group in its own frame.
    const groups = new Map();
    for (const el of elements) {
      const fid = checkUid(pageId, el.uid) ?? 0;
      if (!groups.has(fid)) groups.set(fid, []);
      groups.get(fid).push(el);
    }
    const results = [];
    for (const [fid, els] of groups) {
      const { data } = await runInPage(pageId, (list) => {
        const out = [];
        for (const { uid, value } of list) {
          try { window.__mcp.fill(uid, String(value)); out.push({ uid, ok: true }); }
          catch (e) { out.push({ uid, ok: false, error: String(e.message || e) }); }
        }
        return out;
      }, [els], fid);
      results.push(...data);
    }
    return { results, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async type_text({ pageId, text, submitKey }) {
    await ensureLib(pageId);
    // Type into whichever frame holds focus.
    const frames = await runInAllFrames(pageId, (t) => {
      if (!document.hasFocus()) return false;
      try { return !!window.__mcp.typeText(t); } catch { return false; }
    }, [text]);
    if (!frames.some(f => f.result)) throw new Error('no focused editable element');
    if (submitKey) {
      await runInAllFrames(pageId, (k) => {
        if (document.hasFocus()) window.__mcp.pressKey(k);
      }, [submitKey]);
    }
    return { typed: text.length, submitKey: submitKey || null };
  },

  async press_key({ pageId, key }) {
    // Trusted CDP input only when the debugger is attached AND the tab is
    // visible — Chrome drops Input.* events on background tabs.
    const tab = await chrome.tabs.get(pageId).catch(() => null);
    if (getSession(pageId) && tab && tab.active) {
      try {
        const parts = key.split('+');
        const k = parts.pop();
        const mods = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
        let modifiers = 0;
        for (const m of parts) {
          const mm = m.toLowerCase();
          if (mm === 'alt') modifiers |= mods.alt;
          else if (mm === 'control' || mm === 'ctrl') modifiers |= mods.ctrl;
          else if (mm === 'meta' || mm === 'cmd') modifiers |= mods.meta;
          else if (mm === 'shift') modifiers |= mods.shift;
        }
        const keyDefs = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 } };
        const def = keyDefs[k] || { key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0, text: modifiers === 0 && k.length === 1 ? k : undefined };
        await cdp(pageId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...def });
        await cdp(pageId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def });
        return { pressed: key, via: 'cdp' };
      } catch {}
    }
    await ensureLib(pageId);
    await runInAllFrames(pageId, (k) => { if (document.hasFocus()) window.__mcp.pressKey(k); }, [key]);
    return { pressed: key, via: 'synthetic' };
  },

  async scroll({ pageId, uid, to, dx, dy, includeSnapshot }) {
    await ensureLib(pageId);
    const fid = uid ? checkUid(pageId, uid) : undefined;
    await runInPage(pageId, (o) => window.__mcp.scroll(o), [{ uid, to, dx, dy }], fid);
    return { scrolled: true, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async click_xy({ pageId, x, y, dblClick }) {
    // Coordinate click for surfaces without DOM handles (canvas, maps).
    // Prefer uid-based click whenever possible — coordinates break on scroll/DPR.
    await ensureLib(pageId);
    const { data } = await runInPage(pageId, (x, y, d) => window.__mcp.clickAt(x, y, d), [x, y, !!dblClick]);
    return { clickedAt: { x, y }, hit: data };
  },

  async upload_file({ pageId, uid, filePaths }) {
    // DOM.setFileInputFiles requires CDP. Same-process iframes are included in
    // DOM.getDocument; OOPIF (cross-origin process) file inputs are not reachable.
    await ensureLib(pageId);
    await ensureDebugger(pageId, ['DOM', 'Page']);
    const doc = await cdp(pageId, 'DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp(pageId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-mcp-uid="' + uid + '"]' });
    if (!nodeId) throw new Error('file input not found: ' + uid);
    await cdp(pageId, 'DOM.setFileInputFiles', { files: filePaths, nodeId });
    return { uploaded: filePaths, uid };
  },
};
