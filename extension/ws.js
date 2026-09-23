// WebSocket client running inside the MV3 service worker.
// Connects to the local bridge, auto-reconnects, keeps the SW alive via chrome.alarms.

const ALARM_NAME = 'mcp-keepalive';

export class WSClient {
  constructor(url, onCall) {
    this.url = url;
    this.onCall = onCall; // async (msg) => result payload
    this.ws = null;
    this.connected = false;
    this.backoff = 1000;
    this.pending = new Set();
  }

  start() {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === ALARM_NAME) {
        if (!this.connected) this.connect();
        else this.send({ type: 'ping' });
      }
    });
    // WebSocket traffic doesn't count as extension activity — Chrome kills the
    // SW after ~30s idle even mid-call. A chrome.* API call resets that clock.
    this._keepAlive = setInterval(() => {
      try { chrome.runtime.getPlatformInfo(() => {}); } catch {}
    }, 20000);
    this.connect();
  }

  async connect() {
    if (this._connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this._connecting = true;
    // Probe with fetch first: a refused WebSocket gets logged as an extension
    // error in chrome://extensions (visible noise), while a failed fetch is
    // just a promise rejection. Only open the WS when the bridge answers HTTP.
    // The guard above is NOT enough: the probe awaits while this.ws is still
    // null, so overlapping connect() calls each open a socket. With the
    // bridge's last-wins slot, two sockets then kill each other on every
    // reconnect — a self-sustaining connect storm.
    try {
      const probe = new URL(this.url);
      const ok = await fetch(`http://${probe.host}/`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
      if (!ok) { this.scheduleReconnect(); return; }
    } catch { this.scheduleReconnect(); return; }
    finally { this._connecting = false; }
    // A socket may have appeared while the probe was in flight.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    // If the bridge enforces MCP_EXT_TOKEN it writes extension/.bridge-token —
    // fetch our own packaged file and append it to the WS URL.
    let url = this.url;
    try {
      const t = await fetch(chrome.runtime.getURL('.bridge-token')).then(r => r.ok ? r.text() : null).catch(() => null);
      if (t && t.trim()) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t.trim());
    } catch {}
    let ws;
    try {
      ws = new WebSocket(url);
      this.ws = ws;
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    // A socket stuck in CONNECTING (blackholed handshake) never fires
    // onopen/onclose — and the readyState guard above would make connect()
    // early-return forever. Time it out so onclose drives the next retry.
    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) try { ws.close(); } catch {}
    }, 8000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      this.connected = true;
      this.backoff = 1000;
      this.send({ type: 'hello', name: 'chrome-mcp-extension', version: chrome.runtime.getManifest().version });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'call') {
        const run = this.onCall(msg)
          .then((data) => this.send({ type: 'result', id: msg.id, ok: true, data }))
          .catch((err) => this.send({ type: 'result', id: msg.id, ok: false, error: String(err && err.message || err) }));
        this.pending.add(run);
        run.finally(() => this.pending.delete(run));
      } else if (msg.type === 'pong') {
        // heartbeat ack, nothing to do
      }
    };
    ws.onclose = () => {
      clearTimeout(connectTimer);
      this.connected = false;
      // Don't clobber a newer socket — a stale close must not clear its slot.
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  scheduleReconnect() {
    if (this._reconnectTimer) return; // one pending reconnect at a time
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  status() {
    return { connected: this.connected, url: this.url };
  }
}
