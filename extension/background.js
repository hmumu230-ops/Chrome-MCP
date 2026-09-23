// Service worker entry: WS client + tool dispatch.
import { WSClient } from './ws.js';
import { tabTools } from './handlers/tabs.js';
import { interactTools } from './handlers/interact.js';
import { snapshotTools } from './handlers/snapshot.js';
import { cdpTools, getSession, clearBanned } from './handlers/cdp.js';
import { miscTools } from './handlers/misc.js';
import { clearFrameMap, settle } from './handlers/util.js';

const TOOLS = { ...tabTools, ...interactTools, ...snapshotTools, ...cdpTools, ...miscTools };

// Tools that mutate the page — after these, wait briefly for nav/DOM settle.
const MUTATING = new Set([
  'click', 'click_xy', 'drag', 'fill', 'fill_form', 'type_text', 'press_key',
  'navigate_page', 'new_page', 'select_page', 'close_page', 'scroll',
  'upload_file', 'handle_dialog', 'set_cookie', 'remove_cookie', 'evaluate_script',
]);

const BRIDGE_WS = 'ws://127.0.0.1:7890/ws';

async function dispatch(msg) {
  const fn = TOOLS[msg.tool];
  if (!fn) throw new Error('unknown tool: ' + msg.tool);
  const data = await fn(msg.args || {});
  const pageId = msg.args && msg.args.pageId;
  if (MUTATING.has(msg.tool) && pageId !== undefined && msg.tool !== 'navigate_page') {
    await settle(pageId).catch(() => {});
  }
  // Surface open JS dialogs so the agent sees the modal state in the response.
  const s = pageId !== undefined ? getSession(pageId) : null;
  if (s && s.dialogQueue.length && data && typeof data === 'object' && !data.image) {
    data.modalDialogs = s.dialogQueue.map(d => `${d.type}: "${d.message}"`)
      .concat('Call handle_dialog to resolve before continuing.');
  }
  return data;
}

const ws = new WSClient(BRIDGE_WS, dispatch);
ws.start();

// Keep the SW alive: an offscreen document holds a long-lived runtime port.
// An open port counts as continuous activity — unlike WebSocket traffic or
// outbound API calls, which don't reliably reset Chrome's ~30s idle kill.
(async () => {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Holds a runtime port that keeps the service worker alive between MCP calls.',
      });
    }
  } catch {}
})();
chrome.runtime.onConnect.addListener(() => {});

// Popup queries status through this.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') sendResponse(ws.status());
  if (msg && msg.type === 'reconnect') { ws.connect(); sendResponse({ ok: true }); }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => clearFrameMap(tabId));
// Navigation invalidates uid→frame routing and user-detach bans.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) { clearFrameMap(tabId); clearBanned(tabId); }
});
chrome.runtime.onInstalled.addListener(() => ws.connect());
chrome.runtime.onStartup.addListener(() => ws.connect());
