// Interaction tools — injected DOM library + scripting API.
// Element uids may live in iframes; frameFor() routes calls to the right frame.
import { ensureLib, runInPage, runInAllFrames, frameFor, checkUid } from './util.js';
import { cdp, ensureDebugger, getSession, hasOpenDialog } from './cdp.js';
// Static import: dynamic import() is disallowed in MV3 service workers.
import { snapshotTools } from './snapshot.js';

async function snapshotMaybe(pageId, include) {
  if (!include) return undefined;
  return snapshotTools.take_snapshot({ pageId });
}

// CDP Input.dispatchKeyEvent needs real code/windowsVirtualKeyCode values —
// a blanket 'Key'+upper() produces invalid codes ('KeyARROWLEFT') that CDP
// rejects, silently dropping into the lossy synthetic path.
const CDP_KEYS = {};
for (const [k, code, wvk, text] of [
  ['Enter', 'Enter', 13, '\r'], ['Tab', 'Tab', 9], ['Escape', 'Escape', 27],
  ['Backspace', 'Backspace', 8], ['Delete', 'Delete', 46], [' ', 'Space', 32, ' '],
  ['ArrowLeft', 'ArrowLeft', 37], ['ArrowUp', 'ArrowUp', 38], ['ArrowRight', 'ArrowRight', 39], ['ArrowDown', 'ArrowDown', 40],
  ['Home', 'Home', 36], ['End', 'End', 35], ['PageUp', 'PageUp', 33], ['PageDown', 'PageDown', 34],
  ['Insert', 'Insert', 45], ['Shift', 'ShiftLeft', 16], ['Control', 'ControlLeft', 17], ['Alt', 'AltLeft', 18],
]) CDP_KEYS[k] = { key: k, code, windowsVirtualKeyCode: wvk, text };
for (let i = 1; i <= 12; i++) CDP_KEYS['F' + i] = { key: 'F' + i, code: 'F' + i, windowsVirtualKeyCode: 111 + i };

// Serialize trusted input per tab: interleaved press/release pairs from
// parallel calls get coalesced by Chrome — a click reported ok that never
// landed. Queueing makes each press→release pair atomic.
const inputQueues = new Map();
function queueInput(pageId, fn) {
  const prev = inputQueues.get(pageId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inputQueues.set(pageId, next.catch(() => {}));
  return next;
}

function cdpKeyDef(k, modifiers) {
  const known = CDP_KEYS[k];
  if (known) return known;
  if (k.length === 1) {
    const up = k.toUpperCase();
    const isLetter = /[A-Z]/.test(up), isDigit = /[0-9]/.test(up);
    return {
      key: k,
      // Only letters/digits have predictable code names; symbols omit code
      // rather than emit an invalid one.
      code: isLetter ? 'Key' + up : isDigit ? 'Digit' + up : undefined,
      windowsVirtualKeyCode: (isLetter || isDigit) ? up.charCodeAt(0) : 0,
      text: modifiers === 0 ? k : undefined,
    };
  }
  return { key: k, windowsVirtualKeyCode: 0 };
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
      // CDP input queues behind an open JS dialog — fail fast instead of
      // hanging 25s+ on the modal loop.
      if (hasOpenDialog(pageId)) throw new Error('a JavaScript dialog is open on this page — call handle_dialog first');
      let viaCdp = false;
      try {
        const { data: pt } = await inFrameOf(pageId, uid, (u) => window.__mcp.tryCall('box', u));
        await queueInput(pageId, async () => {
          for (let i = 0; i < (dblClick ? 2 : 1); i++) {
            await cdp(pageId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.cx, y: pt.cy, button: 'left', clickCount: i + 1 });
            await cdp(pageId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.cx, y: pt.cy, button: 'left', clickCount: i + 1 });
          }
        });
        viaCdp = true;
      } catch {}
      // snapshotMaybe AFTER the try: a snapshot failure must not drop into
      // the synthetic path and double-click the element.
      if (viaCdp) return { clicked: uid, via: 'cdp', snapshot: await snapshotMaybe(pageId, includeSnapshot) };
    }
    await inFrameOf(pageId, uid, (u, d) => window.__mcp.tryCall('click', u, d), [!!dblClick]);
    return { clicked: uid, via: 'synthetic', snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async hover({ pageId, uid, includeSnapshot }) {
    await ensureLib(pageId);
    await inFrameOf(pageId, uid, (u) => window.__mcp.tryCall('hover', u));
    return { hovered: uid, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async drag({ pageId, from_uid, to_uid, includeSnapshot }) {
    await ensureLib(pageId);
    checkUid(pageId, to_uid); // to_uid is used raw — validate staleness like from_uid
    // Cross-frame drag is not supported; both uids must be in one frame.
    await inFrameOf(pageId, from_uid, (a, b) => window.__mcp.tryCall('dragTo', a, b), [to_uid]);
    return { dragged: from_uid, onto: to_uid, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async fill({ pageId, uid, value, includeSnapshot }) {
    if (value === undefined || value === null || typeof value === 'object') {
      throw new Error('fill value must be a string/number/boolean (got ' + (value === null ? 'null' : typeof value) + ')');
    }
    await ensureLib(pageId);
    await inFrameOf(pageId, uid, (u, v) => window.__mcp.tryCall('fill', u, v), [String(value)]);
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
        try {
          const out = [];
          for (const { uid, value } of list) {
            try { window.__mcp.fill(uid, String(value)); out.push({ uid, ok: true }); }
            catch (e) { out.push({ uid, ok: false, error: String(e.message || e) }); }
          }
          return { __ok: true, v: out };
        } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
      }, [els], fid);
      results.push(...data);
    }
    return { results, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async type_text({ pageId, text, submitKey }) {
    await ensureLib(pageId);
    // Type into the frame whose activeElement is editable. Don't gate on
    // document.hasFocus() — it's false whenever the OS window is blurred
    // (e.g. agent runs while another app is focused), but DOM focus persists.
    const frames = await runInAllFrames(pageId, (t) => {
      try {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return { __ok: true, v: false };
        if (!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return { __ok: true, v: false };
        return { __ok: true, v: !!window.__mcp.typeText(t) };
      } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
    }, [text]);
    if (!frames.some(f => f.result)) throw new Error('no focused editable element');
    if (submitKey) {
      await runInAllFrames(pageId, (k) => {
        try {
          const el = document.activeElement;
          if (el && el !== document.body && el !== document.documentElement) window.__mcp.pressKey(k);
          return { __ok: true, v: true };
        } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
      }, [submitKey]);
    }
    return { typed: text.length, submitKey: submitKey || null };
  },

  async press_key({ pageId, key }) {
    // Trusted CDP input only when the debugger is attached AND the tab is
    // visible — Chrome drops Input.* events on background tabs.
    const tab = await chrome.tabs.get(pageId).catch(() => null);
    if (getSession(pageId) && tab && tab.active) {
      if (hasOpenDialog(pageId)) throw new Error('a JavaScript dialog is open on this page — call handle_dialog first');
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
        const def = cdpKeyDef(k, modifiers);
        await queueInput(pageId, async () => {
          await cdp(pageId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...def });
          await cdp(pageId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def });
        });
        return { pressed: key, via: 'cdp' };
      } catch {}
    }
    await ensureLib(pageId);
    const frames = await runInAllFrames(pageId, (k) => {
      try {
        const focused = document.hasFocus() || !!(document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement);
        if (focused) window.__mcp.pressKey(k);
        return { __ok: true, v: focused };
      } catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
    }, [key]);
    if (!frames.some(f => f.result === true)) throw new Error('no focused frame — nothing dispatched press_key');
    return { pressed: key, via: 'synthetic' };
  },

  async scroll({ pageId, uid, to, dx, dy, includeSnapshot }) {
    await ensureLib(pageId);
    const fid = uid ? checkUid(pageId, uid) : undefined;
    await runInPage(pageId, (o) => window.__mcp.tryCall('scroll', o), [{ uid, to, dx, dy }], fid);
    return { scrolled: true, snapshot: await snapshotMaybe(pageId, includeSnapshot) };
  },

  async click_xy({ pageId, x, y, dblClick }) {
    // Coordinate click for surfaces without DOM handles (canvas, maps).
    // Prefer uid-based click whenever possible — coordinates break on scroll/DPR.
    await ensureLib(pageId);
    const { data } = await runInPage(pageId, (x, y, d) => window.__mcp.tryCall('clickAt', x, y, d), [x, y, !!dblClick]);
    return { clickedAt: { x, y }, hit: data };
  },

  async upload_file({ pageId, uid, filePaths }) {
    // DOM.setFileInputFiles requires CDP. Same-process iframes are included in
    // DOM.getDocument; OOPIF (cross-origin process) file inputs are not reachable.
    if (!Array.isArray(filePaths) || !filePaths.length || filePaths.some(f => typeof f !== 'string' || !f)) {
      throw new Error('filePaths must be a non-empty array of path strings');
    }
    await ensureLib(pageId);
    const fid = checkUid(pageId, uid);
    await ensureDebugger(pageId, ['DOM', 'Page']);
    // Resolve the REAL element in the isolated world and stamp a one-time
    // token — page JS can forge data-mcp-uid clones onto decoy file inputs,
    // which would exfiltrate the uploaded local file's contents.
    const { data: tok } = await inFrameOf(pageId, uid, (u) => window.__mcp.tryCall('stamp', u));
    let nodeId = 0;
    try {
      const doc = await cdp(pageId, 'DOM.getDocument', { depth: -1 });
      const { nodeIds } = await cdp(pageId, 'DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '[' + tok + ']' });
      if (!nodeIds || nodeIds.length !== 1) throw new Error('file input uid contested (possible page forgery): ' + uid);
      nodeId = nodeIds[0];
      await cdp(pageId, 'DOM.setFileInputFiles', { files: filePaths, nodeId });
    } finally {
      await inFrameOf(pageId, uid, (t) => window.__mcp.tryCall('unstamp', t), [[tok]]).catch(() => {});
    }
    return { uploaded: filePaths, uid };
  },
};
