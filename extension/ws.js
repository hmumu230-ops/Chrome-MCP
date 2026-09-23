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

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.send({ type: 'hello', name: 'chrome-mcp-extension', version: chrome.runtime.getManifest().version });
    };
    this.ws.onmessage = (ev) => {
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
    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try { this.ws && this.ws.close(); } catch {}
    };
  }

  scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    setTimeout(() => this.connect(), delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  status() {
    return { connected: this.connected, url: this.url };
  }
}
