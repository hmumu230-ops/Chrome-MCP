// Poll GET / until extensionConnected=true (max ~10min). Prints each tick.
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const r = await fetch('http://127.0.0.1:7890/');
    const j = await r.json();
    console.log(new Date().toISOString().slice(11, 19), 'ext=' + j.extensionConnected, 'sessions=' + j.sessions);
    if (j.extensionConnected) { console.log('CONNECTED'); break; }
  } catch (e) { console.log(new Date().toISOString().slice(11, 19), 'bridge down:', String(e.message || e).slice(0, 60)); }
  await new Promise(r => setTimeout(r, 8000));
}
process.exit(0);
