function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (s) => {
    const dot = document.getElementById('dot');
    const st = document.getElementById('state');
    if (!s) { st.textContent = 'service worker unavailable'; return; }
    dot.className = 'dot ' + (s.connected ? 'on' : 'off');
    st.textContent = s.connected ? 'Connected to bridge' : 'Bridge not reachable';
  });
}
document.getElementById('re').onclick = () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 800));
};
refresh();
