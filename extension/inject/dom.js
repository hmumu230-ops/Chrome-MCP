// Injected into pages (isolated world) before interaction tools run.
// Provides window.__mcp: uid assignment, a11y-like snapshot, element helpers.
// Idempotent: re-injection preserves the uid counter.

(function () {
  const UID_ATTR = 'data-mcp-uid';
  window.__mcpUid = window.__mcpUid || 0;
  // Per-document random nonce baked into uids: a fresh document after
  // navigation mints uids that can never collide with the previous page's,
  // so a stale uid errors instead of hitting an unrelated look-alike element.
  if (!window.__mcpDoc) window.__mcpDoc = Math.random().toString(36).slice(2, 6);
  // uid prefix set by snapshot() so iframe elements get distinct uids (e.g. "f3d7ke1").
  window.__mcpPrefix = window.__mcpPrefix || '';

  function uid(el) {
    let v = el.getAttribute(UID_ATTR);
    if (!v) {
      v = window.__mcpPrefix + window.__mcpDoc + 'e' + (++window.__mcpUid);
      el.setAttribute(UID_ATTR, v);
    }
    return v;
  }

  function find(u) {
    // Escape for CSS attribute-selector string context — raw interpolation let
    // crafted uids (e.g. `"],input,[x="`) break out and match other elements.
    const safe = String(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = document.querySelector('[' + UID_ATTR + '="' + safe + '"]');
    if (el && !el.isConnected) throw new Error('element detached (stale uid ' + u + ') — call take_snapshot');
    return el;
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function text(el) {
    let t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 80) t = t.slice(0, 80) + '…';
    return t;
  }

  function labelOf(el) {
    return el.getAttribute('aria-label') ||
      (el.id && document.querySelector('label[for="' + el.id + '"]')?.innerText) ||
      el.closest('label')?.innerText || '';
  }

  function roleLine(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const t = text(el);
    const parts = [];
    const push = (s) => { if (s) parts.push(s); };

    if (tag === 'a') { push('link "' + (t || el.href) + '"'); if (el.href) push('href="' + el.href + '"'); }
    else if (tag === 'button' || role === 'button') { push('button "' + (t || labelOf(el)) + '"'); }
    else if (tag === 'select' || role === 'combobox' || role === 'listbox') { push('combobox "' + labelOf(el) + '" value="' + (el.value ?? '') + '"'); }
    else if (tag === 'textarea') { push('textbox "' + labelOf(el) + '" value="' + el.value.slice(0, 60) + '"'); }
    else if (tag === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') push(ty + ' "' + (labelOf(el) || t) + '" checked=' + el.checked);
      else if (ty === 'file') push('fileinput "' + labelOf(el) + '"');
      else if (ty === 'submit' || ty === 'button') push('button "' + (el.value || t) + '"');
      else push('textbox "' + (labelOf(el) || el.placeholder || '') + '" type=' + ty + ' value="' + (el.value || '').slice(0, 60) + '"');
    }
    else if (/^h[1-6]$/.test(tag)) { push('heading "' + t + '" level=' + tag[1]); }
    else if (tag === 'iframe') { push('iframe "' + (el.title || '') + '" src="' + (el.src || 'inline') + '"'); }
    else if (tag === 'img') { push('img "' + (el.alt || '') + '"'); }
    else if (role) { push(role + ' "' + (t || labelOf(el)) + '"'); }
    else if (el.isContentEditable) { push('textbox "contenteditable"'); }
    else return null;
    return parts.join(' ');
  }

  const INTERACTIVE = 'a[href],button,input,select,textarea,[role],[contenteditable="true"],img[alt],summary,[tabindex],iframe';
  const HEADINGS = 'h1,h2,h3,h4,h5,h6';

  function snapshot(prefix) {
    window.__mcpPrefix = prefix || '';
    const lines = [];
    const uids = [];
    let count = 0;
    const MAX = 1500;
    const seen = new Set();
    const walk = (root, depth) => {
      if (count >= MAX || depth > 24) return;
      const el = root;
      if (el.nodeType !== 1) return;
      if (!seen.has(el)) {
        seen.add(el);
        let line = null;
        if (el.matches(INTERACTIVE) || el.matches(HEADINGS)) {
          if (visible(el)) {
            const u = uid(el);
            const rl = roleLine(el) || 'element';
            line = '[' + u + '] ' + rl; count++;
            uids.push(u);
          }
        } else {
          const tag = el.tagName.toLowerCase();
          if ((tag === 'p' || tag === 'li' || tag === 'td' || tag === 'span' || tag === 'div') && visible(el)) {
            const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').replace(/\s+/g, ' ');
            if (own && own.length > 1) { line = '- text "' + (own.length > 100 ? own.slice(0, 100) + '…' : own) + '"'; count++; }
          }
        }
        if (line) lines.push('  '.repeat(Math.min(depth, 12)) + line);
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(document.body || document.documentElement, 0);
    return { url: location.href, title: document.title, lines, uids };
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function fireMouse(el, type, opts = {}) {
    const c = center(el);
    el.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, button: 0 }, opts)));
  }

  function firePointer(el, type, opts = {}) {
    const c = center(el);
    el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, button: 0, isPrimary: true }, opts)));
  }

  window.__mcp = {
    find,
    snapshot,

    // Chrome's executeScript silently returns result:null when the injected
    // function throws (crbug 1271527 — no error propagation). Every call site
    // therefore wraps work in tryCall so errors survive the trip back.
    tryCall(name, ...a) {
      try { return { __ok: true, v: this[name](...a) }; }
      catch (e) { return { __ok: false, err: String(e && e.message || e) }; }
    },

    box(u) {
      const el = find(u);
      if (!el) throw new Error('element not found: ' + u);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      // Zero-size = hidden/collapsed: the caller must NOT translate this into
      // CDP coordinates — that would trusted-click the viewport corner (0,0).
      if (!(r.width > 0 && r.height > 0)) throw new Error('element has zero size (hidden?): ' + u);
      // x/y/cx/cy are viewport coords (Input.dispatch*). docX/docY are document
      // coords — what Page.captureScreenshot's clip expects.
      return {
        x: r.x, y: r.y, width: r.width, height: r.height,
        cx: r.x + r.width / 2, cy: r.y + r.height / 2,
        docX: r.x + scrollX, docY: r.y + scrollY,
      };
    },

    click(u, dbl) {
      const el = find(u);
      if (!el) throw new Error('element not found: ' + u);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      firePointer(el, 'pointerover'); fireMouse(el, 'mouseover');
      firePointer(el, 'pointerdown'); fireMouse(el, 'mousedown');
      firePointer(el, 'pointerup'); fireMouse(el, 'mouseup');
      // el.click() dispatches ONE click and runs the default action (link
      // navigation, form submit) — synthetic MouseEvents never navigate.
      el.click();
      if (dbl) {
        el.click();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }));
      }
      return true;
    },

    hover(u) {
      const el = find(u);
      if (!el) throw new Error('element not found: ' + u);
      el.scrollIntoView({ block: 'center' });
      firePointer(el, 'pointerover'); fireMouse(el, 'mouseover'); fireMouse(el, 'mousemove');
      return true;
    },

    dragTo(fromU, toU) {
      const from = find(fromU), to = find(toU);
      if (!from || !to) throw new Error('drag element not found');
      from.scrollIntoView({ block: 'center' }); to.scrollIntoView({ block: 'center' });
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      // also fire pointer path for non-HTML5 drag implementations
      firePointer(from, 'pointerdown'); firePointer(to, 'pointermove'); firePointer(to, 'pointerup');
      return true;
    },

    fill(u, value) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('fill value must be a string/number/boolean, got: ' + Object.prototype.toString.call(value));
      }
      value = String(value);
      const el = find(u);
      if (!el) throw new Error('element not found: ' + u);
      el.scrollIntoView({ block: 'center' });
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const opt = Array.from(el.options).find(o => o.value === value || o.text === value || o.label === value);
        if (!opt) throw new Error('no matching option: ' + value);
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = value === 'true';
        if (el.checked !== want) el.click();
        return true;
      }
      if (el.isContentEditable) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
        return true;
      }
      el.focus();
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      // InputEvent (not plain Event) — React keys on inputType/data.
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    typeText(str) {
      const el = document.activeElement;
      if (!el || el === document.body) throw new Error('no focused element');
      if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        document.execCommand('insertText', false, str);
      } else {
        for (const ch of str) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
      }
      return true;
    },

    pressKey(spec) {
      // "Control+A", "Enter", "Control+Shift+R"
      const parts = spec.split('+');
      const key = parts.pop();
      const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
      for (const m of parts) {
        const k = m.toLowerCase();
        if (k === 'control' || k === 'ctrl') mods.ctrlKey = true;
        else if (k === 'shift') mods.shiftKey = true;
        else if (k === 'alt') mods.altKey = true;
        else if (k === 'meta' || k === 'cmd') mods.metaKey = true;
      }
      const opts = Object.assign({ key, bubbles: true, cancelable: true }, mods);
      const t = document.activeElement || document.body;
      t.dispatchEvent(new KeyboardEvent('keydown', opts));
      t.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (key === 'Enter' && t.form) t.form.requestSubmit && t.form.requestSubmit();
      return true;
    },

    hasText(texts) {
      const body = document.body ? document.body.innerText : '';
      return texts.some(t => body.includes(t));
    },

    textOf(u) {
      const el = find(u);
      return el ? text(el) : null;
    },

    scroll(opts) {
      // {uid} scrolls element into view; {to:'top'|'bottom'}; {dx,dy} relative.
      opts = opts || {};
      if ('uid' in opts) {
        if (!opts.uid) throw new Error('scroll uid must be a non-empty string');
        const el = find(opts.uid);
        if (!el) throw new Error('element not found: ' + opts.uid);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return { scrolledTo: opts.uid };
      }
      if ('to' in opts && opts.to !== 'top' && opts.to !== 'bottom') throw new Error('scroll "to" must be top|bottom, got: ' + opts.to);
      const dx = opts.dx === undefined ? 0 : Number(opts.dx);
      const dy = opts.dy === undefined ? 0 : Number(opts.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('scroll dx/dy must be finite numbers');
      if (opts.to === 'top') window.scrollTo(0, 0);
      else if (opts.to === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else window.scrollBy(dx, dy);
      return { x: scrollX, y: scrollY };
    },

    clickAt(x, y, dbl) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click_xy requires finite x,y');
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error('nothing at ' + x + ',' + y);
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ isPrimary: true }, opts)));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ isPrimary: true }, opts)));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', Object.assign({ detail: dbl ? 2 : 1 }, opts)));
      if (dbl) el.dispatchEvent(new MouseEvent('dblclick', opts));
      return { tag: el.tagName, text: (el.innerText || '').slice(0, 80) };
    },

    extractText(selector) {
      const root = selector ? document.querySelector(selector) : (document.body || document.documentElement);
      if (!root) throw new Error('selector matched nothing: ' + selector);
      const t = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return { url: location.href, title: document.title, text: t.slice(0, 100000), truncated: t.length > 100000 };
    },
  };
})();
