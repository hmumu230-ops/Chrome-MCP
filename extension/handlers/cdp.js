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
    net: [], netById: new Map(), reqSeq: 0,
    console: [], msgSeq: 0,
    dialogQueue: [],
    pendingDialogAction: undefined,
    tracing: null,
    heapChunks: null,
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

export async function cdp(tabId, method, params = {}) {
  const s = sessions.get(tabId);
  if (s) touch(s, tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
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

export async function ensureDebugger(tabId, domains = []) {
  let s = sessions.get(tabId);
  if (!s) {
    if (banned.has(tabId)) throw new Error('debugger was cancelled by the user on this tab — call attach explicitly or reload the tab');
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (/already attached/i.test(String(e && e.message || e))) {
        await sweepAndAttach(tabId);
      } else {
        throw new Error('cannot attach debugger (DevTools open on this tab?): ' + (e && e.message || e));
      }
    }
    s = newSession();
    sessions.set(tabId, s);
    // Page events power navigation-reset + dialog handling.
    await cdp(tabId, 'Page.enable').catch(() => {});
    s.domains.add('Page');
  }
  for (const d of domains) {
    if (NO_ENABLE.has(d) || s.domains.has(d)) continue;
    await cdp(tabId, d + '.enable').catch(() => {});
    s.domains.add(d);
  }
  touch(s, tabId);
  return s;
}

export function clearBanned(tabId) { banned.delete(tabId); }

export async function detachDebugger(tabId) {
  if (!sessions.has(tabId)) return false;
  try { await chrome.debugger.detach({ tabId }); } catch {}
  sessions.delete(tabId);
  return true;
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const s = sessions.get(tabId);
  if (s && s.tracing) s.tracing.reject(new Error('debugger detached'));
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
      if (!p.frame.parentId) { s.net = []; s.netById.clear(); s.console = []; }
      break;

    case 'Network.requestWillBeSent': {
      const e = {
        reqid: ++s.reqSeq, requestId: p.requestId,
        url: p.request.url, method: p.request.method, type: p.type || 'other',
        requestHeaders: p.request.headers, postData: p.request.postData,
        timestamp: p.timestamp, wallTime: p.wallTime,
      };
      s.netById.set(p.requestId, e);
      pushCapped(s.net, e, MAX_NET);
      break;
    }
    case 'Network.responseReceived': {
      const e = s.netById.get(p.requestId);
      if (e) { e.status = p.response.status; e.responseHeaders = p.response.headers; e.mimeType = p.response.mimeType; }
      break;
    }
    case 'Network.loadingFinished': {
      const e = s.netById.get(p.requestId);
      if (e) e.encodedSize = p.encodedDataLength;
      break;
    }
    case 'Network.loadingFailed': {
      const e = s.netById.get(p.requestId);
      if (e) e.error = p.errorText;
      break;
    }

    case 'Runtime.consoleAPICalled': {
      const e = {
        msgid: ++s.msgSeq, type: p.type,
        text: p.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '),
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

    case 'HeapProfiler.addHeapSnapshotChunk':
      if (s.heapChunks) s.heapChunks.push(p.chunk);
      break;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (s) routeEvent(source.tabId, method, params || {});
});

// ---------- tools ----------

const NET_PRESETS = {
  'Offline':  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G':  { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  'Fast 3G':  { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  'Slow 4G':  { offline: false, latency: 170, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 9 * 1024 * 1024 / 8 },
  'Fast 4G':  { offline: false, latency: 60, downloadThroughput: 40 * 1024 * 1024 / 8, uploadThroughput: 30 * 1024 * 1024 / 8 },
};

export const cdpTools = {
  async list_network_requests({ pageId, pageSize, pageIdx, resourceTypes }) {
    const s = await ensureDebugger(pageId, ['Network']);
    let list = s.net;
    if (resourceTypes && resourceTypes.length) list = list.filter(r => resourceTypes.includes(r.type));
    const start = (pageIdx || 0) * (pageSize || list.length);
    const items = list.slice(start, pageSize ? start + pageSize : undefined);
    return { total: list.length, requests: items.map(({ postData, requestHeaders, responseHeaders, ...r }) => r) };
  },

  async get_network_request({ pageId, reqid, requestFilePath, responseFilePath }) {
    const s = await ensureDebugger(pageId, ['Network']);
    let e;
    if (reqid === undefined) e = s.net[s.net.length - 1];
    else e = s.net.find(r => r.reqid === reqid);
    if (!e) throw new Error(reqid === undefined ? 'no network requests recorded' : 'no such request: ' + reqid);
    let body;
    try {
      const r = await cdp(pageId, 'Network.getResponseBody', { requestId: e.requestId });
      body = r.base64Encoded
        ? new TextDecoder().decode(Uint8Array.from(atob(r.body), c => c.charCodeAt(0)))
        : r.body;
    } catch {}
    const out = { ...e, responseBody: body };
    if (requestFilePath || responseFilePath) {
      return {
        file: responseFilePath ? { path: responseFilePath, content: body || '' } : undefined,
        requestFile: requestFilePath ? { path: requestFilePath, content: e.postData || '' } : undefined,
        meta: { ...e, responseBody: undefined },
      };
    }
    return out;
  },

  async list_console_messages({ pageId, pageSize, pageIdx, types }) {
    const s = await ensureDebugger(pageId, ['Runtime', 'Log']);
    let list = s.console;
    if (types && types.length) list = list.filter(m => types.includes(m.type));
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
    if (!s.dialogQueue.length) throw new Error('no open dialog on this page');
    const d = s.dialogQueue.shift();
    await cdp(pageId, 'Page.handleJavaScriptDialog', {
      accept: action === 'accept', promptText,
    });
    return { handled: d, action };
  },

  async emulate({ pageId, networkConditions, cpuThrottlingRate, geolocation, userAgent, colorScheme, viewport, extraHttpHeaders }) {
    await ensureDebugger(pageId, ['Network', 'Emulation']);
    const applied = {};
    if (networkConditions !== undefined) {
      const preset = NET_PRESETS[networkConditions];
      if (!preset) throw new Error('unknown network preset: ' + networkConditions);
      await cdp(pageId, 'Network.emulateNetworkConditions', preset);
      applied.networkConditions = networkConditions;
    }
    if (cpuThrottlingRate !== undefined) {
      await cdp(pageId, 'Emulation.setCPUThrottlingRate', { rate: cpuThrottlingRate });
      applied.cpuThrottlingRate = cpuThrottlingRate;
    }
    if (geolocation !== undefined) {
      if (!geolocation) await cdp(pageId, 'Emulation.clearGeolocationOverride');
      else {
        const [lat, lon] = geolocation.split(',').map(Number);
        await cdp(pageId, 'Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy: 100 });
      }
      applied.geolocation = geolocation || 'cleared';
    }
    if (userAgent !== undefined) {
      await cdp(pageId, 'Emulation.setUserAgentOverride', { userAgent });
      applied.userAgent = userAgent || 'cleared';
    }
    if (colorScheme !== undefined) {
      await cdp(pageId, 'Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: colorScheme === 'auto' ? '' : colorScheme }],
      });
      applied.colorScheme = colorScheme;
    }
    if (viewport !== undefined) {
      const m = viewport.match(/^(\d+)x(\d+)x([\d.]+)((?:,mobile|,touch|,landscape)*)$/);
      if (!m) throw new Error('bad viewport format: ' + viewport);
      const flags = m[4];
      const [, w, h, dpr] = m;
      await cdp(pageId, 'Emulation.setDeviceMetricsOverride', {
        width: +w, height: +h, deviceScaleFactor: +dpr,
        mobile: flags.includes('mobile'),
        screenOrientation: flags.includes('landscape')
          ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      });
      if (flags.includes('touch')) await cdp(pageId, 'Emulation.setTouchEmulationEnabled', { enabled: true });
      applied.viewport = viewport;
    }
    if (extraHttpHeaders !== undefined) {
      await cdp(pageId, 'Network.setExtraHTTPHeaders', { headers: extraHttpHeaders ? JSON.parse(extraHttpHeaders) : {} });
      applied.extraHttpHeaders = extraHttpHeaders ? 'set' : 'cleared';
    }
    return { applied };
  },

  async performance_start_trace({ pageId, reload }) {
    const s = await ensureDebugger(pageId, ['Performance', 'Tracing']);
    if (s.tracing) throw new Error('trace already running');
    s.tracing = { chunks: [], resolve: null, reject: null };
    await cdp(pageId, 'Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-v8.cpu_profiler,v8.execute,blink.user_timing',
      transferMode: 'ReportEvents',
    });
    if (reload) await chrome.tabs.reload(pageId);
    return { started: true };
  },

  async performance_stop_trace({ pageId, filePath }) {
    const s = await ensureDebugger(pageId, ['Performance', 'Tracing']);
    if (!s.tracing) throw new Error('no active trace');
    const done = new Promise((resolve, reject) => { s.tracing.resolve = resolve; s.tracing.reject = reject; });
    await cdp(pageId, 'Tracing.end');
    const chunks = await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error('trace flush timeout')), 60000))]);
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

  async take_heapsnapshot({ pageId, filePath }) {
    const s = await ensureDebugger(pageId, ['HeapProfiler']);
    s.heapChunks = [];
    await cdp(pageId, 'HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    const data = s.heapChunks.join('');
    s.heapChunks = null;
    return { file: filePath ? { path: filePath, content: data } : undefined, bytes: data.length };
  },

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
