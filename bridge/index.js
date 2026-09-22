// Universal Browser MCP bridge.
// - MCP clients connect via Streamable HTTP:  http://127.0.0.1:7890/mcp
// - The Chrome extension connects via WS:     ws://127.0.0.1:7890/ws
// - GET / returns status JSON.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MCP_PORT || 7890);
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT || 120000);
const MAX_BODY = 4 * 1024 * 1024;
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 45 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- access control ----------
// The MCP spec requires localhost HTTP servers to validate the Origin header
// (DNS-rebinding protection): a browser page could otherwise POST to us.
const LOCAL_RE = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function localHostOnly(req) {
  const host = (req.headers.host || '').split(':')[0];
  return LOCAL_HOSTS.has(host);
}

function httpAccessError(req) {
  if (!localHostOnly(req)) return 'forbidden host';
  const origin = req.headers.origin;
  if (origin && !LOCAL_RE.test(origin) && !origin.startsWith('chrome-extension://')) {
    return 'forbidden origin: ' + origin;
  }
  if (process.env.MCP_TOKEN) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + process.env.MCP_TOKEN) return 'missing/invalid bearer token';
  }
  return null;
}

// Extension pinning: the first chrome-extension:// origin that connects is
// persisted; later WS upgrades from other extension ids are rejected.
const PIN_FILE = path.join(__dirname, '.extension-id');
let pinnedExtOrigin = null;
try { pinnedExtOrigin = fs.readFileSync(PIN_FILE, 'utf8').trim() || null; } catch {}

function wsAllowed(req) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws') return false;
  if (!localHostOnly(req)) return false;
  // Single-slot: one extension channel only.
  if (extSocket && extSocket.readyState === 1) return false;
  const origin = req.headers.origin;
  // Browsers always send Origin on WS upgrade; the MV3 service worker sends
  // chrome-extension://<id>. Anything else with an Origin header is a webpage
  // trying to hijack the channel.
  if (origin) {
    if (!origin.startsWith('chrome-extension://')) return false;
    if (pinnedExtOrigin && origin !== pinnedExtOrigin) return false;
    if (!pinnedExtOrigin) {
      pinnedExtOrigin = origin;
      try { fs.writeFileSync(PIN_FILE, origin); } catch {}
      console.log('[bridge] pinned extension origin:', origin);
    }
    return true;
  }
  // Non-browser WS clients (tests, other tools): allowed, but require token
  // when MCP_EXT_TOKEN is configured.
  if (process.env.MCP_EXT_TOKEN) return url.searchParams.get('token') === process.env.MCP_EXT_TOKEN;
  return true;
}

// ---------- extension channel ----------

let extSocket = null;
let seq = 0;
const pending = new Map();
const MAX_PENDING = 256;

function callExtension(tool, args) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== 1) {
      return reject(new Error('Chrome extension not connected — load the extension in Chrome and keep Chrome open.'));
    }
    if (pending.size >= MAX_PENDING) return reject(new Error('too many in-flight calls'));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`extension call timeout (${tool})`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    extSocket.send(JSON.stringify({ type: 'call', id, tool, args }));
  });
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  extSocket = ws;
  console.log('[bridge] extension connected');
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'extension error'));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'hello') {
      console.log(`[bridge] hello from ${msg.name} v${msg.version}`);
    }
  });
  ws.on('close', () => {
    if (extSocket === ws) extSocket = null;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); pending.delete(id); }
    console.log('[bridge] extension disconnected');
  });
  ws.on('error', () => {});
});

// ---------- result formatting ----------

function writeOut(file, content) {
  const dir = path.dirname(path.resolve(file.path));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file.path, file.base64 ? Buffer.from(content ?? '', 'base64') : (content ?? ''));
}

function formatResult(data) {
  if (data && data.image) {
    return { content: [{ type: 'image', data: data.image.base64, mimeType: data.image.mimeType || 'image/png' }] };
  }
  const notes = [];
  let rest = data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const { file, requestFile, image, ...r } = data;
    rest = r;
    for (const f of [file, requestFile]) {
      if (f && f.path) {
        try { writeOut(f, f.content); notes.push(`saved: ${f.path}`); }
        catch (e) { notes.push(`failed to write ${f.path}: ${e.message}`); }
      }
    }
  }
  const body = JSON.stringify(rest ?? null, null, 2);
  const out = { content: [{ type: 'text', text: notes.length ? notes.join('\n') + '\n' + body : body }] };
  // structuredContent must be a JSON object per spec — wrap bare arrays.
  if (rest && typeof rest === 'object') out.structuredContent = Array.isArray(rest) ? { items: rest } : rest;
  return out;
}

// Tool annotations (MCP spec): clients use these for permission UIs.
const ANNOTATIONS = {
  list_pages: { readOnlyHint: true },
  take_snapshot: { readOnlyHint: true },
  take_screenshot: { readOnlyHint: true },
  wait_for: { readOnlyHint: true },
  list_network_requests: { readOnlyHint: true },
  get_network_request: { readOnlyHint: true },
  list_console_messages: { readOnlyHint: true },
  get_console_message: { readOnlyHint: true },
  get_cookies: { readOnlyHint: true },
  list_downloads: { readOnlyHint: true },
  extract_text: { readOnlyHint: true },
  take_heapsnapshot: { readOnlyHint: true },
  close_page: { destructiveHint: true },
  remove_cookie: { destructiveHint: true },
  handle_dialog: { destructiveHint: true },
  evaluate_script: { destructiveHint: true },
  select_page: { idempotentHint: true },
  resize_page: { idempotentHint: true },
  emulate: { idempotentHint: true },
  detach_debugger: { idempotentHint: true },
  performance_stop_trace: { idempotentHint: true },
};

// ---------- MCP server (one per session) ----------

function createMcpServer() {
  const server = new Server(
    { name: 'universal-browser-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      ...t,
      annotations: { openWorldHint: true, ...(ANNOTATIONS[t.name] || {}) },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const data = await callExtension(name, args || {});
      return formatResult(data);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
  return server;
}

// ---------- HTTP server ----------

const transports = new Map(); // sessionId -> { transport, lastSeen }

function touchSession(id) {
  const t = transports.get(id);
  if (t) t.lastSeen = Date.now();
  return t && t.transport;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of transports) {
    if (now - t.lastSeen > SESSION_TTL_MS) {
      transports.delete(id);
      t.transport.close().catch(() => {});
    }
  }
}, 60 * 1000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
    let d = '';
    const timer = setTimeout(() => { reject(new Error('body read timeout')); req.destroy(); }, 10000);
    req.on('data', (c) => {
      d += c;
      if (d.length > MAX_BODY) { clearTimeout(timer); reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => { clearTimeout(timer); try { resolve(d ? JSON.parse(d) : undefined); } catch (e) { reject(e); } });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => { clearTimeout(timer); reject(new Error('request closed')); });
  });
}

const httpServer = http.createServer(async (req, res) => {
  const err = httpAccessError(req);
  if (err) { res.writeHead(403, { 'content-type': 'text/plain' }).end(err); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name: 'universal-browser-mcp-bridge',
      mcpEndpoint: `http://${HOST}:${PORT}/mcp`,
      extensionConnected: !!(extSocket && extSocket.readyState === 1),
      sessions: transports.size,
    }));
    return;
  }

  if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }

  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) { res.writeHead(e.message === 'payload too large' ? 413 : 400).end(String(e.message)); return; }

    let transport = sessionId ? touchSession(sessionId) : undefined;
    if (!transport) {
      if (!sessionId && body && isInitializeRequest(body)) {
        if (transports.size >= MAX_SESSIONS) { res.writeHead(503).end('too many sessions'); return; }
        const entry = { transport: null, lastSeen: Date.now() };
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { entry.transport = t; transports.set(id, entry); },
        });
        t.onclose = () => { if (t.sessionId) transports.delete(t.sessionId); };
        await createMcpServer().connect(t);
        transport = t;
      } else {
        // 404 so clients re-initialize (spec convention), not 400.
        res.writeHead(404).end('No valid session. Send initialize first.');
        return;
      }
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    const transport = sessionId ? touchSession(sessionId) : undefined;
    if (!transport) { res.writeHead(404).end('Invalid or missing session ID'); return; }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405).end();
});

httpServer.on('upgrade', (req, socket, head) => {
  if (!wsAllowed(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[bridge] MCP endpoint : http://${HOST}:${PORT}/mcp`);
  console.log(`[bridge] extension WS : ws://${HOST}:${PORT}/ws`);
  if (pinnedExtOrigin) console.log(`[bridge] pinned extension: ${pinnedExtOrigin}`);
});
