// CDP layer — chrome.debugger session management, event collectors,
// and tools that require the DevTools protocol (network, console, emulation,
// performance traces, dialogs, heap snapshots).
//
// NOTE: while chrome.debugger is attached to a tab, Chrome shows the
// "debugging this browser" infobar. Sessions attach lazily on first use
// and stay attached; detachDebugger removes the banner.

const sessions = new Map(); // tabId -> session

const NO_ENABLE = new Set(['Input', 'IO', 'Target', 'Browser', 'Inspector', 'Emulation', 'Tracing']);

const MAX_NET = 2000;
const MAX_CONSOLE = 2000;

function newSession() {
  return {
    domains: new Set(),
    net: [], netById: new Map(), reqSeq: 0, currentLoader: null,
    console: [], msgSeq: 0,
    dialogQueue: [],
    pendingDialogAction: undefined,
    tracing: null,
  };
}

// Tabs where the user cancelled debugging via the infobar — don't auto-reattach.
const banned = new Set();
// Idle auto-detach: hide the "debugging" infobar after IDLE_MS without CDP calls.
const IDLE_MS = 5 * 60 * 1000;

export function getSession(tabId) {
  return sessions.get(tabId);
}

export function setPendingDialogAction(tabId, action) {
  const s = sessions.get(tabId);
  if (s) s.pendingDialogAction = action;
}

// Script-injecting tools use this to fail fast instead of hanging the call:
// chrome.scripting.executeScript queues behind a modal JS dialog.
export function hasOpenDialog(tabId) {
  const s = sessions.get(tabId);
  return !!(s && s.dialogQueue.length);
}

export async function cdp(tabId, method, params = {}, timeoutMs = 30000) {
  const s = sessions.get(tabId);
  if (s) touch(s, tabId);
  // chrome.debugger.sendCommand can hang forever on some commands (e.g.
  // Page.captureScreenshot with captureBeyondViewport on some builds) —
  // race it with a timeout so the tool fails instead of wedging the call.
  return await Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), timeoutMs)),
  ]);
}

function touch(s, tabId) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => detachDebugger(tabId), IDLE_MS);
}

async function sweepAndAttach(tabId) {
  // Recover from zombie attachments left by an extension/SW restart:
  // the sessions Map is empty but Chrome still holds the old attach.
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.tabId === tabId && t.attached) {
        try { await chrome.debugger.detach({ tabId }); } catch {}
      }
    }
  } catch {}
  await chrome.debugger.attach({ tabId }, '1.3');
}

// Serialize attach attempts per tab — parallel first-attaches race and a
// losing sweepAndAttach detaches a sibling's in-flight session.
const attachLocks = new Map(); // tabId -> Promise (serialized attach attempts)

export function ensureDebugger(tabId, domains = []) {
  const lock = (attachLocks.get(tabId) || Promise.resolve())
    .then(() => _ensureDebugger(tabId, domains));
  attachLocks.set(tabId, lock.catch(() => {}));
  return lock;
}

async function _ensureDebugger(tabId, domains) {
  let s = sessions.get(tabId);
  if (!s) {
    if (banned.has(tabId)) throw new Error('debugger was cancelled by the user on this tab — call attach explicitly or reload the tab');
    try {
      // attach can hang under load; a hung promise would wedge this tab's
      // attach-lock chain forever.
      await Promise.race([
        chrome.debugger.attach({ tabId }, '1.3'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('debugger attach timeout')), 15000)),
      ]);
    } catch (e) {
      if (/already attached/i.test(String(e && e.message || e))) {
        await sweepAndAttach(tabId);
      } else {
        throw new Error('cannot attach debugger (DevTools open on this tab?): ' + (e && e.message || e));
      }
    }
    s = newSession();
    sessions.set(tabId, s);
    // Page events power navigation-reset + dialog handling. Short timeout:
    // a JS dialog already open parks the renderer — Page.enable stalls ~30s
    // otherwise, and we only mark the domain after it actually answers.
    if (await enableDomain(tabId, 'Page')) s.domains.add('Page');
  }
  for (const d of domains) {
    if (NO_ENABLE.has(d) || s.domains.has(d)) continue;
    if (await enableDomain(tabId, d)) s.domains.add(d);
  }
  touch(s, tabId);
  return s;
}

// Domain enables use a short timeout: an already-open JS dialog parks the
// renderer, and the default 30s cdp timeout would stall every attach.
async function enableDomain(tabId, d) {
  try { await cdp(tabId, d + '.enable', {}, 4000); return true; }
  catch { return false; } // retried on the next ensureDebugger call
}

export function clearBanned(tabId) { banned.delete(tabId); }

export async function detachDebugger(tabId) {
  const s = sessions.get(tabId);
  if (!s) return false;
  // Reject pending work before deleting the session — otherwise an in-flight
  // trace stop hangs until the 60s flush timeout. reject may be null when a
  // trace was started but never stopped — guard or the TypeError aborts the
  // whole detach and wedges the session.
  if (s.tracing) { const t = s.tracing; s.tracing = null; if (typeof t.reject === 'function') t.reject(new Error('debugger detached')); }
  try { await chrome.debugger.detach({ tabId }); } catch {}
  sessions.delete(tabId);
  return true;
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const s = sessions.get(tabId);
  if (s && s.tracing) { const t = s.tracing; s.tracing = null; if (typeof t.reject === 'function') t.reject(new Error('debugger detached')); }
  sessions.delete(tabId);
  // User clicked "Cancel" on the infobar — respect that, don't reattach silently.
  if (reason === 'canceled_by_user') banned.add(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));

// ---------- event routing ----------

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function routeEvent(tabId, s, method, p) {
  switch (method) {
    case 'Page.frameNavigated':
      // Don't clear net on navigation: requestWillBeSent can arrive BEFORE
      // frameNavigated for the new document. Tag requests with loaderId and
      // filter at read time instead. Console has no loaderId — clear it.
      // Dialogs dismissed by navigation never emit a close event — drop the
      // queue too or stale entries lie to the next handle_dialog.
      if (!p.frame.parentId) { s.currentLoader = p.frame.loaderId; s.console = []; s.dialogQueue = []; }
      break;

    case 'Network.requestWillBeSent': {
      // A redirect hop: the SAME requestId re-fires requestWillBeSent with the
      // previous response in redirectResponse. Record the hop's status so the
      // chain isn't lost and the old entry doesn't look eternally in-flight.
      if (p.redirectResponse) {
        const prev = s.netById.get(p.requestId);
        if (prev) {
          prev.status = p.redirectResponse.status;
          prev.responseHeaders = p.redirectResponse.headers;
          prev.mimeType = p.redirectResponse.mimeType;
          prev.redirectTo = p.request.url;
        }
      }
      const e = {
        reqid: ++s.reqSeq, requestId: p.requestId, loaderId: p.loaderId,
        url: p.request.url, method: p.request.method, type: p.type || 'other',
        requestHeaders: p.request.headers, postData: p.request.postData,
        timestamp: p.timestamp, wallTime: p.wallTime,
      };
      // CORS preflights carry a different loaderId than the page — tag them
      // so the loader filter can keep them visible instead of vanishing.
      if (e.method === 'OPTIONS' && e.loaderId !== s.currentLoader) e.preflight = true;
      s.netById.set(p.requestId, e);
      pushCapped(s.net, e, MAX_NET);
      break;
    }
    case 'Network.requestWillBeSentExtraInfo': {
      // requestWillBeSent.headers is a REDUCED set — the full wire headers
      // (Cookie, Accept, sec-fetch-*, Host…) only arrive via ExtraInfo.
      const e = s.netById.get(p.requestId);
      if (e && p.headers) e.requestHeaders = { ...e.requestHeaders, ...p.headers };
      break;
    }
    case 'Network.responseReceivedExtraInfo': {
      const e = s.netById.get(p.requestId);
      if (e && p.headers) e.responseHeaders = { ...e.responseHeaders, ...p.headers };
      if (e && p.statusCode && e.status === undefined) e.status = p.statusCode;
      break;
    }
    case 'Network.webSocketCreated': {
      const e = {
        reqid: ++s.reqSeq, requestId: p.requestId, loaderId: s.currentLoader,
        url: p.url, method: 'WS', type: 'websocket',
        timestamp: p.timestamp,
      };
      s.netById.set(p.requestId, e);
      pushCapped(s.net, e, MAX_NET);
      break;
    }
    case 'Network.webSocketHandshakeResponseReceived': {
      const e = s.netById.get(p.requestId);
      if (e) { e.status = p.response.status; e.responseHeaders = p.response.headers; }
      break;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const e = s.netById.get(p.requestId);
      if (e) {
        if (!e.frames) e.frames = [];
        pushCapped(e.frames, {
          dir: method === 'Network.webSocketFrameSent' ? 'sent' : 'recv',
          opcode: p.response && p.response.opcode, mask: p.response && p.response.mask,
          data: (p.response && p.response.payloadData || '').slice(0, 500),
          timestamp: p.timestamp,
        }, 200);
      }
      break;
    }
    case 'Network.webSocketFrameError': {
      const e = s.netById.get(p.requestId);
      if (e) e.frameError = p.errorMessage;
      break;
    }
    case 'Network.webSocketClosed': {
      const e = s.netById.get(p.requestId);
      if (e) e.closed = true;
      break;
    }
    case 'Network.responseReceived': {
      const e = s.netById.get(p.requestId);
      if (e) {
        e.status = p.response.status; e.responseHeaders = p.response.headers; e.mimeType = p.response.mimeType;
        e.protocol = p.response.protocol;
        if (p.response.fromDiskCache) e.fromDiskCache = true;
        if (p.response.fromServiceWorker) e.fromServiceWorker = true;
        if (p.response.timing) e.timing = p.response.timing;
        e.responseTs = p.timestamp;
      }
      break;
    }
    case 'Network.loadingFinished': {
      const e = s.netById.get(p.requestId);
      if (e) { e.encodedSize = p.encodedDataLength; e.endTimestamp = p.timestamp; e.durationMs = Math.round((p.timestamp - e.timestamp) * 1000); }
      break;
    }
    case 'Network.loadingFailed': {
      const e = s.netById.get(p.requestId);
      if (e) {
        // 204/304/HEAD legitimately finish with ERR_ABORTED (no body stream) —
        // reporting them as errors makes successes look like failures.
        const noBodyStatus = e.status === 204 || e.status === 304 || e.method === 'HEAD';
        if (p.errorText === 'net::ERR_ABORTED' && (noBodyStatus || e.type === 'EventSource')) {
          e.endTimestamp = p.timestamp; e.durationMs = Math.round((p.timestamp - e.timestamp) * 1000);
        } else e.error = p.errorText;
      }
      break;
    }

    case 'Runtime.consoleAPICalled': {
      const e = {
        msgid: ++s.msgSeq, type: p.type,
        text: p.args.map(a => {
          if (a.value !== undefined) return String(a.value);
          // Plain objects carry their real shape in preview.properties —
          // a.description is just "Object" and loses everything.
          if (a.preview && a.preview.properties) {
            const inner = a.preview.properties.map(pr => pr.name + ': ' + (pr.value !== undefined ? pr.value : (pr.valuePreview ? pr.valuePreview.description : pr.type))).join(', ');
            return (a.description || 'Object') + ' {' + inner + (a.preview.overflow ? ', …' : '') + '}';
          }
          return a.description || a.type;
        }).join(' ').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
        timestamp: p.timestamp,
        url: p.stackTrace && p.stackTrace.callFrames[0] && p.stackTrace.callFrames[0].url,
      };
      pushCapped(s.console, e, MAX_CONSOLE);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails;
      pushCapped(s.console, {
        msgid: ++s.msgSeq, type: 'error',
        text: d.text + (d.exception && d.exception.description ? ' ' + d.exception.description : ''),
        timestamp: p.timestamp, url: d.url,
      }, MAX_CONSOLE);
      break;
    }
    case 'Log.entryAdded': {
      const en = p.entry;
      pushCapped(s.console, {
        msgid: ++s.msgSeq, type: en.level, text: en.text,
        timestamp: en.timestamp, url: en.url,
      }, MAX_CONSOLE);
      break;
    }

    case 'Page.javascriptDialogOpening': {
      const d = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
      const action = s.pendingDialogAction;
      if (action) {
        cdp(tabId, 'Page.handleJavaScriptDialog', {
          accept: action !== 'dismiss',
          promptText: action !== 'accept' && action !== 'dismiss' ? action : undefined,
        }).catch(() => {});
        s.pendingDialogAction = undefined;
      } else {
        s.dialogQueue.push(d);
      }
      break;
    }

    case 'Tracing.dataCollected':
      if (s.tracing) s.tracing.chunks.push(...(p.value || []));
      break;
    case 'Tracing.tracingComplete':
      if (s.tracing) { const t = s.tracing; s.tracing = null; t.resolve(t.chunks); }
      break;

  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (s) routeEvent(source.tabId, s, method, params || {});
});

// ---------- tools ----------

const NET_PRESETS = {
  'None':     { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  'Offline':  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G':  { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  'Fast 3G':  { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  'Slow 4G':  { offline: false, latency: 170, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 9 * 1024 * 1024 / 8 },
  'Fast 4G':  { offline: false, latency: 60, downloadThroughput: 40 * 1024 * 1024 / 8, uploadThroughput: 30 * 1024 * 1024 / 8 },
};

export const cdpTools = {
  async list_network_requests({ pageId, pageSize, pageIdx, resourceTypes, method, url }) {
    const s = await ensureDebugger(pageId, ['Network']);
    // Preflight entries carry a different loaderId — keep them visible (tagged)
    // instead of silently dropping them.
    let list = s.currentLoader ? s.net.filter(r => r.loaderId === s.currentLoader || r.preflight) : s.net;
    if (resourceTypes && resourceTypes.length) list = list.filter(r => resourceTypes.includes(r.type));
    if (method) list = list.filter(r => r.method === String(method).toUpperCase());
    if (url) { const needle = String(url).toLowerCase(); list = list.filter(r => r.url.toLowerCase().includes(needle)); }
    const start = (pageIdx || 0) * (pageSize || list.length);
    const items = list.slice(start, pageSize ? start + pageSize : undefined);
    return { total: list.length, requests: items.map(({ postData, requestHeaders, responseHeaders, frames, ...r }) => ({ ...r, frames: frames ? frames.length : undefined })) };
  },

  async get_network_request({ pageId, reqid, requestFilePath, responseFilePath }) {
    const s = await ensureDebugger(pageId, ['Network']);
    const list = s.currentLoader ? s.net.filter(r => r.loaderId === s.currentLoader || r.preflight) : s.net;
    let e;
    if (reqid === undefined) e = list[list.length - 1];
    else e = list.find(r => r.reqid === reqid);
    if (!e) throw new Error(reqid === undefined ? 'no network requests recorded' : 'no such request: ' + reqid);
    let body, bodyBase64;
    if (e.redirectTo) {
      // Redirect hop: getResponseBody only ever returns the FINAL hop's body —
      // returning it here would silently attribute it to this hop.
      e = { ...e, bodyNote: 'redirect hop — body lives on the final request (reqid ' + (list[list.length - 1] && list[list.length - 1].reqid) + ')' };
    } else {
      try {
        const r = await cdp(pageId, 'Network.getResponseBody', { requestId: e.requestId });
        if (r.base64Encoded) {
          // Binary-safe: never TextDecoder-mangle raw bytes. Text bodies stay
          // inline; undecodable bytes come back as base64.
          try { body = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(r.body), c => c.charCodeAt(0))); }
          catch { bodyBase64 = r.body; }
        } else body = r.body;
      } catch {}
    }
    const out = { ...e, responseBody: body, responseBodyBase64: bodyBase64 };
    const INLINE_CAP = 200000;
    if (body && body.length > INLINE_CAP) {
      out.responseBody = body.slice(0, INLINE_CAP);
      out.responseBodyTruncated = true;
      out.responseBodyNote = 'truncated at ' + INLINE_CAP + ' chars — use responseFilePath for the full body';
    }
    if (requestFilePath || responseFilePath) {
      return {
        // Raw bytes to disk: pass the base64 wire form through untouched.
        file: responseFilePath ? { path: responseFilePath, content: bodyBase64 !== undefined ? bodyBase64 : (body || ''), base64: bodyBase64 !== undefined } : undefined,
        requestFile: requestFilePath ? { path: requestFilePath, content: e.postData || '' } : undefined,
        meta: { ...e, responseBody: undefined, responseBodyBase64: undefined },
      };
    }
    return out;
  },

  async list_console_messages({ pageId, pageSize, pageIdx, types }) {
    const s = await ensureDebugger(pageId, ['Runtime', 'Log']);
    let list = s.console;
    // CDP calls warn-level 'warning' — accept the colloquial spelling too.
    if (types && types.length) {
      const want = types.map(t => t === 'warn' ? 'warning' : t);
      list = list.filter(m => want.includes(m.type));
    }
    const start = (pageIdx || 0) * (pageSize || list.length);
    const items = list.slice(start, pageSize ? start + pageSize : undefined);
    return { total: list.length, messages: items };
  },

  async get_console_message({ pageId, msgid }) {
    const s = await ensureDebugger(pageId, ['Runtime', 'Log']);
    const m = s.console.find(x => x.msgid === msgid);
    if (!m) throw new Error('no such console message: ' + msgid);
    return m;
  },

  async handle_dialog({ pageId, action, promptText }) {
    const s = await ensureDebugger(pageId, ['Page']);
    if (s.dialogQueue.length) {
      const d = s.dialogQueue.shift();
      try {
        await cdp(pageId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept', promptText,
        });
      } catch (e) {
        if (/no dialog/i.test(String(e && e.message || e))) throw new Error('queued dialog was already dismissed — nothing to handle');
        throw e;
      }
      return { handled: d, action };
    }
    // A dialog opened BEFORE the debugger attached never fired
    // javascriptDialogOpening — the queue is empty but a modal may be up.
    // Send the handle command blind; -32602 means truly nothing is open.
    try {
      await cdp(pageId, 'Page.handleJavaScriptDialog', {
        accept: action === 'accept', promptText,
      }, 5000);
      return { handled: { type: 'unknown', note: 'dialog opened before debugger attach' }, action };
    } catch (e) {
      if (/no dialog|invalid|-32602/i.test(String(e && e.message || e))) throw new Error('no open dialog on this page');
      throw e;
    }
  },

  async emulate({ pageId, networkConditions, cpuThrottlingRate, geolocation, userAgent, colorScheme, reducedMotion, timezoneId, locale, viewport, extraHttpHeaders }) {
    // Validate EVERYTHING before touching the page — a bad value must not
    // leave partial emulation applied behind a thrown error.
    const plan = []; // [method, params, key, value]
    if (networkConditions !== undefined) {
      const preset = NET_PRESETS[networkConditions];
      if (!preset) throw new Error('unknown network preset: ' + networkConditions + ' (use "None" to clear)');
      plan.push(['Network.emulateNetworkConditions', preset, 'networkConditions', networkConditions]);
    }
    if (cpuThrottlingRate !== undefined) {
      const rate = Number(cpuThrottlingRate);
      if (!Number.isFinite(rate) || rate < 1 || rate > 100) throw new Error('cpuThrottlingRate must be a number 1-100');
      plan.push(['Emulation.setCPUThrottlingRate', { rate }, 'cpuThrottlingRate', rate]);
    }
    if (geolocation !== undefined) {
      if (!geolocation) plan.push(['Emulation.clearGeolocationOverride', {}, 'geolocation', 'cleared']);
      else {
        const [lat, lon, extra] = String(geolocation).split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || extra !== undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          throw new Error('geolocation must be "lat,lon" with |lat|<=90 |lon|<=180');
        }
        plan.push(['Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy: 100 }, 'geolocation', geolocation]);
      }
    }
    if (userAgent !== undefined) plan.push(['Emulation.setUserAgentOverride', { userAgent }, 'userAgent', userAgent || 'cleared']);
    const mediaFeatures = [];
    const applied = {};
    if (colorScheme !== undefined) {
      if (!['dark', 'light', 'auto'].includes(colorScheme)) throw new Error('colorScheme must be dark|light|auto');
      mediaFeatures.push({ name: 'prefers-color-scheme', value: colorScheme === 'auto' ? '' : colorScheme });
      applied.colorScheme = colorScheme;
    }
    if (reducedMotion !== undefined) {
      if (!['reduce', 'no-preference', 'auto'].includes(reducedMotion)) throw new Error('reducedMotion must be reduce|no-preference|auto');
      mediaFeatures.push({ name: 'prefers-reduced-motion', value: reducedMotion === 'auto' ? '' : reducedMotion });
      applied.reducedMotion = reducedMotion;
    }
    if (mediaFeatures.length) plan.push(['Emulation.setEmulatedMedia', { features: mediaFeatures }, null]);
    if (timezoneId !== undefined) plan.push(['Emulation.setTimezoneOverride', { timezoneId }, 'timezoneId', timezoneId || 'cleared']);
    if (locale !== undefined) plan.push(['Emulation.setLocaleOverride', { locale }, 'locale', locale || 'cleared']);
    if (viewport !== undefined) {
      if (!viewport) {
        plan.push(['Emulation.clearDeviceMetricsOverride', {}, 'viewport', 'cleared']);
        // Clearing the viewport must also drop touch emulation.
        plan.push(['Emulation.setTouchEmulationEnabled', { enabled: false }, null]);
      } else {
        const m = viewport.match(/^(\d+)x(\d+)x([\d.]+)((?:,mobile|,touch|,landscape)*)$/);
        if (!m) throw new Error('bad viewport format: ' + viewport);
        const flags = m[4];
        const [, w, h, dpr] = m;
        const dprN = +dpr;
        if (+w < 1 || +h < 1) throw new Error('viewport dims must be >= 1: ' + viewport);
        if (!Number.isFinite(dprN) || dprN <= 0 || dprN > 10) throw new Error('viewport dpr out of range: ' + dpr);
        plan.push(['Emulation.setDeviceMetricsOverride', {
          width: Math.min(+w, 16384), height: Math.min(+h, 16384), deviceScaleFactor: dprN,
          mobile: flags.includes('mobile'),
          screenOrientation: flags.includes('landscape')
            ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
        }, 'viewport', viewport]);
        // Touch must track the flag both ways — otherwise a second emulate
        // without ',touch' leaves stale touch emulation on.
        plan.push(['Emulation.setTouchEmulationEnabled', { enabled: flags.includes('touch') }, null]);
      }
    }
    if (extraHttpHeaders !== undefined) {
      let headers = {};
      if (extraHttpHeaders) {
        try { headers = JSON.parse(extraHttpHeaders); } catch { throw new Error('extraHttpHeaders must be a JSON object string'); }
      }
      plan.push(['Network.setExtraHTTPHeaders', { headers }, 'extraHttpHeaders', extraHttpHeaders ? 'set' : 'cleared']);
    }
    await ensureDebugger(pageId, ['Network', 'Emulation']);
    for (const [method, params, key, value] of plan) {
      await cdp(pageId, method, params);
      if (key) applied[key] = value;
    }
    return { applied };
  },

  async performance_start_trace({ pageId, reload }) {
    const s = await ensureDebugger(pageId, ['Performance', 'Tracing']);
    if (s.tracing) throw new Error('trace already running');
    await cdp(pageId, 'Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-v8.cpu_profiler,v8.execute,blink.user_timing',
      transferMode: 'ReportEvents',
    });
    // Set tracing only after Tracing.start succeeded — a failed start must
    // not leave phantom state that wedges later start/stop calls.
    s.tracing = { chunks: [], resolve: null, reject: null, stopping: false };
    if (reload) await chrome.tabs.reload(pageId);
    return { started: true };
  },

  async performance_stop_trace({ pageId, filePath }) {
    const s = await ensureDebugger(pageId, ['Performance', 'Tracing']);
    if (!s.tracing) throw new Error('no active trace');
    if (s.tracing.stopping) throw new Error('trace stop already in progress');
    s.tracing.stopping = true;
    const done = new Promise((resolve, reject) => { s.tracing.resolve = resolve; s.tracing.reject = reject; });
    let chunks;
    try {
      await cdp(pageId, 'Tracing.end');
      chunks = await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error('trace flush timeout')), 60000))]);
    } catch (e) {
      // Leave the stop retryable: tracingComplete may still arrive, but a
      // failed Tracing.end or a flush timeout must not wedge the tab.
      if (s.tracing) s.tracing.stopping = false;
      throw e;
    }
    let metrics;
    try {
      const m = await cdp(pageId, 'Performance.getMetrics');
      metrics = Object.fromEntries(m.metrics.map(x => [x.name, x.value]));
    } catch {}
    const traceJson = JSON.stringify({ traceEvents: chunks });
    return {
      file: filePath ? { path: filePath, content: traceJson } : undefined,
      eventCount: chunks.length,
      metrics,
      note: filePath ? 'trace written to file' : 'trace too large to inline; pass filePath to save',
    };
  },

  // NOTE: take_heapsnapshot was removed — chrome.debugger does not expose the
  // HeapProfiler domain ("method wasn't found" -32601). Heap capture would need
  // a real CDP pipe (--remote-debugging-port), not the extension debugger.

  async save_pdf({ pageId, filePath, landscape, scale, printBackground }) {
    await ensureDebugger(pageId, ['Page']);
    const { data } = await cdp(pageId, 'Page.printToPDF', {
      landscape: !!landscape,
      scale: scale || 1,
      printBackground: printBackground !== false,
      transferMode: 'ReturnAsBase64',
    });
    return { file: filePath ? { path: filePath, content: data, base64: true } : undefined, bytes: data.length * 3 / 4 };
  },

  async detach_debugger({ pageId }) {
    return { detached: await detachDebugger(pageId) };
  },
};
