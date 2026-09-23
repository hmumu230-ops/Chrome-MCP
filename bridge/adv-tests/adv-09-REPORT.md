# adv-09 — Network Capture Adversarial Test — Final Report

Target: chrome-mcp network capture (`list_network_requests` / `get_network_request`)
Implementation under test: `extension/handlers/cdp.js` (+ `bridge/index.js`, `bridge/tools.js`)
Test server: `bridge/adv-tests/adv-09-server.mjs` on :8125 (`/redirect`, `/r30x/N`, `/slow`, `/sse`, `/ws-echo`, `/big`, `/204`, `/nocors`, `/cache`, `/sw-*`, `/hang`, `/post-echo`, `/download.bin`, `/xorigin` …)
Evidence log: `bridge/adv-tests/adv-09-results.txt` (1623 lines)

Legend: PASS / FAIL / PARTIAL / NOTE

## A. Regression targets

| # | Case | Verdict | Evidence |
|---|------|---------|----------|
| A1 | WebSocket visible in capture | **PARTIAL** | Entry captured: reqid 41 `{url: ws://localhost:8125/ws-echo, method: "WS", type: "websocket", closed: true}`. Frames/handshake missing (see A4). |
| A2 | Redirect chains keep per-hop status | **PASS** | 3-hop chains for 301/302/307/308: each hop = own entry with correct status + `redirectTo` + per-hop `location` response header (reqids 18–37). Mixed chain (301→302→302→200) correct (34–37). Cross-origin redirect localhost→127.0.0.1 preserved (38–39). |
| A3 | Redirect-hop body | **FAIL** | `get_network_request` on hop reqid 18 (301) returns `responseBody: "FINAL"` — identical to final hop. CDP reuses requestId; `Network.getResponseBody` can only return the last hop's body. Intermediate-hop bodies unreachable. |
| A4 | WebSocket handshake + frames | **FAIL** | No status 101, no handshake req/resp headers, no `webSocketFrameSent/Received/HandshakeResponse` handling — cdp.js handles only `webSocketCreated` (180–189) and `webSocketClosed` (190–194). Echo traffic flowed (eval returned `echo:ping-1`) but zero frames recorded. |

## B. Resource-type coverage

| # | Type | Verdict | Evidence |
|---|------|---------|----------|
| B1 | fetch | PASS | reqid 6 type `Fetch` 200 |
| B2 | XHR | PASS | reqid 7 type `XHR` 200 |
| B3 | `<img>` | PASS | reqid 4 type `Image` 200 |
| B4 | `<script>` | PASS | reqid 3 type `Script` 200 |
| B5 | stylesheet | PASS | reqid 2 type `Stylesheet` 200 |
| B6 | font | PASS | reqid 8 type `Font` 200 (request captured even though font decode failed) |
| B7 | JSON POST | PASS | reqid 9, `postData` = `{"a":1,"s":"héllo-页面"}` (unicode intact) |
| B8 | FormData upload | **FAIL** | reqid 10 captured w/ multipart Content-Type header but **no `postData` field** — multipart body not captured. (urlencoded bodies ARE captured — `a=1&b=h%C3%A9llo`.) |
| B9 | download response | PASS/NOTE | fetch of `content-disposition: attachment` captured (reqid 11, header + body). **But** real `<a download>` click produced NO network entry (before=after=6) — browser downloads don't emit `Network.requestWillBeSent`. |
| B10 | SSE/EventSource | PASS | reqid 40/63 type `EventSource` 200; mid-stream = status set, no terminal marker; close → `error:net::ERR_ABORTED` |
| B11 | WebSocket frames | FAIL | see A4 |
| B12 | `data:` URL | PASS | reqid 5 (img data:) type Image; reqid 12 (fetch data:) type `Other`, status 200 |
| B13 | `blob:` URL | PASS | reqid 13 `blob:http://localhost:8125/…`, status 200 (fetch returned `blobbody-xyz`) |
| B14 | service-worker-served | PARTIAL | reqid 42 SW-synthesized 200 body `SW-SYNTH`; reqids 43–44 SW cache. **No `fromServiceWorker` flag** — `encodedSize:0` is the only hint. |
| B15 | cache hit / 304 | PARTIAL/FAIL | cache hit captured (reqid 46, `encodedSize:0`) but **no `fromCache`/`fromMemoryCache` field**. Revalidation shows effective 200, wire 304 masked (reqid 47). Manual `If-None-Match` → status 304 captured BUT with `error:net::ERR_ABORTED` (reqid 62). |
| B16 | CORS failure | PARTIAL | failed request captured: reqid 15 `error:net::ERR_FAILED`, no status. **But preflight OPTIONS invisible** — see B17. |
| B17 | CORS preflight (OPTIONS) | **FAIL** | reqid sequence jumped 65→67: preflight entry exists but is filtered out — cdp.js:171 tags `p.loaderId`, :292 filters `=== s.currentLoader`; Chrome gives preflights a different loaderId. |
| B18 | aborted fetch | PASS | reqid 16 `error:net::ERR_ABORTED`, no status — distinct from in-flight |
| B19 | HTTP/2 | PARTIAL | h2 fetch captured (reqids 17/64, status 200) but **no `protocol` field** → cannot verify h2/multiplexing from tool output |
| B20 | other methods | PASS | PUT, DELETE, HEAD all captured with correct method (reqids 67–69) |

## C. Detail fidelity

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| C1 | Request headers complete | **FAIL** | Only 5–6 headers (Referer, UA, sec-ch-ua*, content-type). Missing: Accept, Accept-Encoding, sec-fetch-*, Cookie, Host, Origin, Content-Length. Needs `Network.requestWillBeSentExtraInfo`. |
| C2 | Response headers | PASS | Wire set captured: Connection, Date, Keep-Alive, Transfer-Encoding, ACAO, content-type, content-disposition, location, etag (possibly also incomplete w/o ExtraInfo, but observed set is plausible-complete). |
| C3 | Request body | PARTIAL | JSON + urlencoded `postData` captured; **multipart/FormData absent** (B8). |
| C4 | Text/JSON response body | PASS | `{"ok":true,"n":42,"s":"héllo"}` — exact, unicode preserved. |
| C5 | Binary/image response body | **FAIL** | Base64→UTF-8 decode corrupts bytes: img.png body `PNG`→`PNG` with ``; download.bin mangled. Root cause cdp.js:309–310 `new TextDecoder().decode(Uint8Array.from(atob(…)))`. **File output inherits corruption**: `D:\adv09-out\img.png` starts `ef bf bd 50 4e 47` (real PNG = `89 50 4e 47`); 4096-byte blob.bin written as 8192 bytes. |
| C6 | Body >1 MB / truncation | PASS w/ NOTE | 1.5 MB returned **in full inline** (bodyLen 1 500 000, encodedSize 1 510 449). No cap exists — OK if intended, but a context-size hazard for the MCP client. |
| C7 | 204 / 304 / HEAD status | **FAIL** | Statuses correct (204/304) but ALL no-body responses get `error:net::ERR_ABORTED` (reqids 14, 62, 69) — successful responses look like failures. |
| C8 | In-flight vs failed | PASS (regression verified) | `/hang` mid-flight: entry has url/method/type/timestamp, **no status/error/encodedSize** → clearly in-flight. Failed: `error` set, no status. Mid-stream SSE: status present, no terminal marker, body absent. `get_network_request` on in-flight returns meta without throwing. |
| C9 | Timing accuracy | **FAIL** | Only start `timestamp`+`wallTime`. No end-time/duration/TTFB fields. `/slow?ms=1500` wall-clock ≈1.77 s confirmed externally but request object exposes nothing to measure duration. |
| C10 | resourceTypes filter | PASS | Fetch→40, XHR→1, Image→2, websocket→1, bogus type→0 |
| C11 | method / URL filter | **FAIL** | `method`/`url`/`urlPattern` NOT in schema (tools.js:150–153) — passed args silently ignored, returned all 50. No error. |
| C12 | Pagination | PASS | pageSize/pageIdx correct (p1=1–5, p2=6–10, no overlap); pageIdx 999→empty; pageSize 0→returns all (treated as "no limit"). |
| C13 | Navigation / stale entries | PASS | After nav: list = 5 new-loader entries; stale `/slow`,`/hang` filtered out (`[]`). |
| C14 | Lazy debugger attach | NOTE/FAIL | Debugger attaches on first network tool call → requests before that are never captured (initial page load → 0 entries until attach + reload). |
| C15 | Default/invalid reqid | PASS | no reqid → last entry (57); `reqid:99999` → `Error: no such request: 99999`. |
| C16 | File output paths | PASS w/ NOTE | Writes outside repo succeed (`D:\adv09-out\*`); repo paths refused by bridge protected-root policy (by design). Text request file exact; binary files corrupted (C5). |
| C17 | reqid stability | NOTE | hidden entries (preflight) still consume reqids → gaps (65→67). |

## Summary

- **PASS**: 17 cases
- **PARTIAL**: 6 (WS entry w/o handshake/frames; SW w/o flag; cache w/o flag & masked 304; h2 w/o protocol; CORS w/o preflight; body>1MB uncapped)
- **FAIL**: 9 — A3 redirect-hop body, A4 WS frames, B8 multipart postData, B17 preflight invisible, C1 request headers, C5 binary corruption (inline + file), C7 no-body→ERR_ABORTED, C9 no timing/duration, C11 method/URL filters unsupported+silently ignored

## Suggested fixes (for implementer)

1. `webSocketHandshakeResponseReceived` / `webSocketFrameSent` / `webSocketFrameReceived` → status 101, headers, frame log.
2. `requestWillBeSentExtraInfo` + `responseReceivedExtraInfo` → full header sets (cookies, sec-fetch, accept-*).
3. Binary bodies: keep base64, expose `bodyBase64`/`bodyEncoding` or write raw bytes to `responseFilePath` (decode only for text MIME).
4. Record `loadingFinished.timestamp` → `duration`, `endTimestamp`, `ttfb` (from `responseReceived.timing`).
5. Don't set `error` for benign no-body aborts (204/304/HEAD/SSE-close) — or add `aborted`/`completed` terminal flag distinct from error.
6. `postData` for multipart (use `request.postData` still — Chrome omits it; need `requestWillBeSentExtraInfo` or raw post data fetch) — document limitation at minimum.
7. Expose `fromDiskCache`/`fromServiceWorker`/`fromPrefetchCache`/`protocol` from `responseReceived`.
8. Preflight: include entries whose `loaderId` differs (or tag `isPreflight`) instead of dropping them.
9. Add `method`/`url`/`urlPattern` filters to schema or reject unknown filter args.
10. Redirect-hop bodies: document that only final-hop body is retrievable via `getResponseBody` (or capture via `dataReceived` if needed).
