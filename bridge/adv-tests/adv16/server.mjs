// adv-16 console test server. Ports 8126 (main) + 8127 (cross-origin iframe source).
import http from 'node:http';
const page = (t, body, head='') => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title>${head}</head><body>${body}</body></html>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:8126');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  switch (u.pathname) {
    case '/basic':
      res.end(page('basic', '<h1>basic</h1>')); break;
    case '/early':
      res.end(page('early', '<h1>early</h1>',
        '<script>console.log("EARLY-HEAD-LOG");console.warn("EARLY-HEAD-WARN");console.error("EARLY-HEAD-ERR");</script>'
        + '<script>window.addEventListener("DOMContentLoaded",()=>console.log("EARLY-DOMCONTENT"));</script>')); break;
    case '/frame-inner':
      res.end(page('fi', 'inner',
        '<script>console.log("SAMEORIGIN-FRAME-LOG");window.flog=(m)=>console.log("FRAME-EVAL:"+String(m));</script>')); break;
    case '/with-iframe':
      res.end(page('wi', '<h1>outer</h1><iframe src="/frame-inner" id="f"></iframe>',
        '<script>console.log("OUTER-PAGE-LOG")</script>')); break;
    case '/with-xiframe':
      res.end(page('wxi', '<h1>outer-x</h1><iframe src="http://127.0.0.1:8127/xframe-inner" id="xf"></iframe>',
        '<script>console.log("XOUTER-PAGE-LOG")</script>')); break;
    case '/csp':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; img-src 'none'; connect-src 'none'; script-src 'unsafe-inline'" });
      res.end(page('csp', '<h1>csp</h1>',
        '<script>window.addEventListener("load",()=>{setTimeout(()=>{'
        + 'try{fetch("https://blocked.invalid/data").catch(()=>{})}catch(e){}'
        + 'try{new Image().src="https://blocked.invalid/i.png"}catch(e){}'
        + 'try{eval("1+1")}catch(e){console.log("EVAL-BLOCKED:"+e.name)}'
        + '},50)});</script>')); break;
    case '/nav-a':
      res.end(page('navA', '<h1>A</h1>', '<script>console.log("NAV-A-LOG")</script>')); break;
    case '/nav-b':
      res.end(page('navB', '<h1>B</h1>', '<script>console.log("NAV-B-LOG")</script>')); break;
    case '/crash-fetch':
      res.end(page('cf', '<h1>fetch</h1>')); break;
    default:
      res.writeHead(404); res.end('not found: ' + u.pathname);
  }
});
srv.listen(8126, '0.0.0.0', () => console.log('main on 8126'));

const srv2 = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(page('xfi', 'xinner',
    '<script>console.log("XORIGIN-FRAME-LOG");window.xflog=(m)=>console.log("XFRAME-EVAL:"+String(m));</script>'));
});
srv2.listen(8127, '0.0.0.0', () => console.log('xorigin on 8127'));
