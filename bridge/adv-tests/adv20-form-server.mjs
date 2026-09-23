// adv-20 form workflow server. Port 8129.
// GET  /       -> full test form (text/email/select/radio/checkbox/file/textarea/submit)
// POST /submit -> capture urlencoded body to submissions.log + echo summary
// GET  /log    -> dump captured submissions
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(dir, 'adv20-submissions.log');

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>adv20 form</title></head><body>
<h1>adv20 test form</h1>
<form method="post" action="/submit">
  <label>Name <input type="text" name="txt" id="txt"></label><br>
  <label>Email <input type="email" name="email" id="email"></label><br>
  <label>Plan <select name="sel" id="sel">
    <option value="">--</option><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option>
  </select></label><br>
  <fieldset><legend>Size</legend>
    <label><input type="radio" name="rad" value="r1" id="rad1"> Small</label>
    <label><input type="radio" name="rad" value="r2" id="rad2"> Large</label>
  </fieldset>
  <fieldset><legend>Extras</legend>
    <label><input type="checkbox" name="chk" value="c1" id="chk1"> Peppers</label>
    <label><input type="checkbox" name="chk" value="c2" id="chk2"> Onions</label>
  </fieldset>
  <label>Attach <input type="file" name="file" id="file"></label><br>
  <label>Notes <textarea name="ta" id="ta" rows="3"></textarea></label><br>
  <button type="submit" id="go">Send it</button>
</form>
</body></html>`;

const MUTATE = `<!doctype html><html><head><meta charset="utf-8"><title>adv20 mutate</title></head><body>
<h1>mutation page</h1>
<div id="host"><button id="victim" onclick="document.body.dataset.clicked='yes'">Mutating button</button></div>
<script>
window.mutate = function () {
  const host = document.getElementById('host');
  const b = document.createElement('button');
  b.id = 'victim2';
  b.textContent = 'Replacement button';
  b.addEventListener('click', () => { document.body.dataset.clicked = 'yes2'; });
  host.replaceChildren(b);
};
// auto-mutate after 4s to simulate SPA behaviour
setTimeout(window.mutate, 4000);
</script>
</body></html>`;

const CHAIN = `<!doctype html><html><head><meta charset="utf-8"><title>adv20 chain</title></head><body>
<h1>chain page</h1>
<label>Query <input id="q" type="text"></label>
<button id="go">Go</button>
<div id="out"></div>
<div id="done" style="display:none"></div>
<script>
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('q').value || '(empty)';
  const out = document.getElementById('out');
  out.innerHTML = '<em>searching...</em>';
  setTimeout(() => {
    out.innerHTML = '<a href="#" id="result1" data-q="' + v.replace(/"/g, '&quot;') + '">Result for ' + v + '</a>';
    document.getElementById('result1').addEventListener('click', ev => {
      ev.preventDefault();
      const d = document.getElementById('done');
      d.style.display = 'block';
      d.textContent = 'CLICKED:' + ev.target.dataset.q;
      document.title = 'clicked ' + ev.target.dataset.q;
    });
  }, 900);
});
</script>
</body></html>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:8129');
  if (u.pathname === '/mutate') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(MUTATE);
  }
  if (u.pathname === '/chain') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(CHAIN);
  }
  if (u.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(FORM);
  }
  if (u.pathname === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const rec = {};
      for (const [k, v] of params) {
        if (rec[k] === undefined) rec[k] = v;
        else rec[k] = [].concat(rec[k], v);
      }
      rec.__file = params.get('file');
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>RECEIVED</h1><pre>' + JSON.stringify(rec, null, 2) + '</pre>');
    });
    return;
  }
  if (u.pathname === '/log') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(empty)');
  }
  res.writeHead(404); res.end('nope');
});
srv.listen(8129, '127.0.0.1', () => console.log('form server on 8129'));
