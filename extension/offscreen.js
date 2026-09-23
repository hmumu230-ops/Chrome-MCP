// Keeps the MV3 service worker alive: an open runtime port plus periodic
// port messages count as extension activity, preventing Chrome's ~30s idle
// termination (WebSocket traffic alone doesn't reliably reset that clock).
(function connect() {
  const port = chrome.runtime.connect({ name: 'keepalive' });
  const beat = setInterval(() => {
    try { port.postMessage({ ping: Date.now() }); } catch { clearInterval(beat); }
  }, 20000);
  port.onDisconnect.addListener(() => {
    clearInterval(beat);
    setTimeout(connect, 1000);
  });
})();
