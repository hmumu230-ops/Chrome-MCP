// Misc tools: cookies, downloads, readable-text extraction.
import { ensureLib, runInPage, runInAllFrames } from './util.js';

export const miscTools = {
  async get_cookies({ pageId, name }) {
    const tab = await chrome.tabs.get(pageId);
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    const list = name ? cookies.filter(c => c.name === name) : cookies;
    return {
      url: tab.url,
      cookies: list.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        expirationDate: c.expirationDate, session: c.session,
      })),
    };
  },

  async set_cookie({ pageId, name, value, path, domain, secure, httpOnly, sameSite, expirationDate }) {
    const tab = await chrome.tabs.get(pageId);
    const c = await chrome.cookies.set({
      url: tab.url, name, value, path, domain, secure, httpOnly, sameSite, expirationDate,
    });
    if (!c) throw new Error('cookie rejected (check domain/path/secure constraints)');
    return { set: name, domain: c.domain };
  },

  async remove_cookie({ pageId, name }) {
    const tab = await chrome.tabs.get(pageId);
    const res = await chrome.cookies.remove({ url: tab.url, name });
    if (!res) throw new Error('cookie not found: ' + name);
    return { removed: name };
  },

  async list_downloads({ limit, state }) {
    const items = await chrome.downloads.search({
      limit: limit || 20,
      orderBy: ['-startTime'],
      ...(state ? { state } : {}),
    });
    return {
      downloads: items.map(d => ({
        id: d.id, filename: d.filename, url: d.url, state: d.state,
        bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
        startTime: d.startTime, mime: d.mime, exists: d.exists, danger: d.danger,
      })),
    };
  },

  async http_request({ url, method, headers, body, timeout, filePath }) {
    // Fetch from the extension's service worker: carries the browser's cookies
    // (credentials: 'include') and is not subject to page CORS — the extension
    // has <all_urls> host permission. Handy for API debugging with live sessions.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 30000);
    try {
      const res = await fetch(url, {
        method: method || 'GET',
        headers, body, credentials: 'include',
        signal: ctrl.signal,
      });
      const meta = {
        status: res.status, statusText: res.statusText, url: res.url,
        headers: Object.fromEntries(res.headers.entries()),
      };
      if (filePath) {
        const buf = await res.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { ...meta, file: { path: filePath, content: btoa(bin), base64: true } };
      }
      const text = await res.text();
      return { ...meta, body: text.slice(0, 200000), truncated: text.length > 200000 };
    } finally { clearTimeout(timer); }
  },

  async download_file({ url, filename, conflictAction }) {
    // Direct download into the browser's Downloads dir via chrome.downloads.
    const id = await chrome.downloads.download({
      url, filename, conflictAction: conflictAction || 'uniquify', saveAs: false,
    });
    // Wait for terminal state (up to 2 min).
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const [d] = await chrome.downloads.search({ id });
      if (d && (d.state === 'complete' || d.state === 'interrupted')) {
        return { id, filename: d.filename, state: d.state, totalBytes: d.totalBytes, error: d.error };
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return { id, state: 'in_progress', note: 'still downloading after 120s' };
  },

  async extract_text({ pageId, selector }) {
    await ensureLib(pageId);
    const frames = await runInAllFrames(pageId, (sel) => {
      try { return window.__mcp.extractText(sel); } catch { return null; }
    }, [selector]);
    const main = frames.find(f => f.frameId === 0 && f.result);
    const subs = frames.filter(f => f.frameId !== 0 && f.result && f.result.text);
    const out = { ...(main ? main.result : { url: '', title: '', text: '' }) };
    if (subs.length) out.frames = subs.map(f => ({ frameId: f.frameId, url: f.result.url, text: f.result.text }));
    return out;
  },
};
