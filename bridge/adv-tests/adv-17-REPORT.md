# adv-17 — Concurrency & Races report

Environment note: the bridge was under **heavy concurrent load from other
adversarial testers** during this run (multiple stray node processes, a rogue
/ws spammer `adv03-ws-channel.mjs`, session cap hit 50/50 repeatedly, and the
bridge process itself was silently killed/restarted ~12× — exit code -1/1 with
**zero stderr**, i.e. `TerminateProcess`-style death, not a JS exception; my own
isolated bridge instance on :7891 survived all identical traffic patterns).
Results below are from windows where `extensionConnected:true` was stable.

## T1 — 50 parallel tools/call on ONE session — PASS
15×evaluate_script(unique token) + 10×list_pages + 10×take_snapshot +
15×new_page fired simultaneously on one session.
`responses=50 idMismatch=0 evalBad=0 listBad=0 snapBad=0 newBad=0 dupPageIds=0 maxMs=~1s`
Every JSON-RPC response carried its request id; every eval returned its own
token; every new_page returned a distinct pageId. No cross-talk.
(Verified twice; the earlier FAIL was my tests using about:blank — unscriptable,
see L1.)

## T2a — click ∥ navigate ∥ screenshot on same tab ×20 — PASS w/ gray zone
- nav 20/20 ok; screenshot 18/20 ok (2× "Only screenshots from surface are
  allowed" — clean error, acceptable).
- clicks: 14 clean errors ("Frame with ID 0 was removed", "element not found",
  "injected function returned nothing"), 6 ok (4 synthetic, 2 cdp).
- window.name click-ledger: "AA" — **no wrong-element hits** (0×'B' even though
  the nav targets swap button positions). uid doc-nonces + frameMap staleness
  guard hold up under nav races.
- GRAY ZONE: 6 clicks returned `{clicked}` but only 2 recorded — clicks that
  "succeeded" on a document that was being discarded have no observable effect
  (or the ledger write was lost in commit teardown). Not a wrong-element click;
  a possibly-harmless phantom success. Callers racing nav can't rely on the
  ok result implying a visible effect.

## T2b — click ∥ same-document position swap ×20 — PASS
Debugger attached → all 20 clicks went via **CDP Input.dispatchMouseEvent**
(box lookup → coords → dispatch is a TOCTOU window). Concurrent evaluate_script
swapped A/B positions every round. Result: ca=20, cb=0 — all hits on A.
The box→dispatch gap (~1 IPC round-trip) is small; 20 tries didn't hit the
swap window. Theoretically still possible — not proven safe, just not observed.

## T3 — take_snapshot during rapid DOM mutation — PASS
Page mutating every ~3ms (60 buttons + gen marker + self-mutating srcdoc
iframe; note: background-tab timer throttling slowed the mutator to ~7 gens
over the window). 30 sequential + 8 parallel snapshots: 38/38 ok, all uids
unique per snapshot, all main-frame gen markers internally consistent —
snapshot is a synchronous DOM walk, cannot tear. Multi-frame (iframe lines
present in all 38) also consistent.

## T4 — 20 parallel new_page — PASS
20/20 created, all pageIds unique, all present in subsequent list_pages.

## T5 — multiple MCP sessions — PASS (isolation) / observed 1 stranded call
10 parallel sessions: unique sids, each did new_page+evaluate+list_pages;
tokens correctly routed (each session got its own `sess-k-token`), shared-page
marker readable across sessions (page state shared by design — frameMaps are
keyed by tabId, not session — documented behavior, uid sharing across sessions
works).
ONE eval call hung >60s — mechanism confirmed separately as B1 below.

## T6 — hanging call / pending-slot behavior — PASS + related bug B1
`evaluate_script` returning a promise parked by `window.__relHang` hung as
designed. During the hang: list_pages ~20ms, take_snapshot ~39ms, second
evaluate_script on the SAME page ~3.2s (slower — Chrome-side contention with
the pending executeScript, still completes). Releasing the page promise
resolved the hung call; subsequent calls unaffected. MCP_CALL_TIMEOUT=120s not
waited out per instructions.

## T7 — rapid connect/disconnect ×50 — PASS
40 sequential init+DELETE + 5 parallel burst + 3 mid-call DELETEs:
sessions 37→37 (leaked=0), 40 cycles in 268ms, no errors. Session cleanup via
DELETE → transport.onclose works. (Abandoned sessions without DELETE persist
to the 45min TTL — observed 42+ stale sessions earlier; that's the documented
sweeper design.)

## T8 — same uid ×10 parallel clicks — CONFIRMED BUG
- **Synthetic path** (no debugger): 10 calls → ca=10, cb=0 — exact.
- **CDP path** (debugger attached, tab active): 10 calls, ALL returned
  `{clicked, via:'cdp'}` → only **4 clicks actually landed** (ca 10→14; a
  second run showed 8/10). Interleaved `Input.dispatchMouseEvent`
  press/release pairs at identical coords are silently coalesced/dropped by
  the browser's input pipeline while every call reports success.
- Sequential CDP control: +5 → all landed.
- No exactly-once/at-least-once guarantee on the CDP path under concurrency;
  success response does NOT imply the click event was delivered.

## B1 — CONFIRMED BUG: extSocket slot-theft strands pending calls + leaks calls
Repro `adv-17-slottheft.mjs`: a local WS client with **no Origin** connects to
ws://127.0.0.1:7890/ws (allowed by design — "trusted-localhost" model, logs a
WARNING). Last-wins: it becomes `extSocket`, real extension is terminated.
- **Call interception**: a real `evaluate_script` tools/call was delivered to
  the rogue socket — full `{id, tool, args}` payload received.
- **health lies**: `extensionConnected` reported `true` while the rogue socket
  held the slot (it only checks `extSocket.readyState===1`).
- **Pending stranding**: `ws.on('close')` skips the pending flush when a
  replacement socket already took the slot (`if (extSocket !== ws) return`),
  so calls dispatched to a socket that then dies hang until the 120s
  CALL_TIMEOUT — the T5 straggler (60s client timeout) was exactly this, and
  it can also happen on ordinary extension-SW restarts that reconnect quickly.
  Fix direction: tag each pending entry with the socket it was sent on and
  flush on THAT socket's close.

## B2 — bridge process instability (attribution uncertain)
12+ silent exits (code -1/1, no stderr) during the session, some ~300ms after
listen with zero traffic — consistent with external TerminateProcess (other
testers' kill tests / AV) rather than a defect in index.js. My isolated
instance survived WS floods (200×), 60 parallel inits, and 100 parallel calls.
Reported for completeness; not proven a chrome-mcp bug.

## L1 — LIMITATION: about:blank is not scriptable
`evaluate_script`/`take_snapshot` on about:blank pages fail with
"Cannot access contents of url about:blank ... matchAboutBlank must be true"
(manifest lacks matchAboutBlank). new_page defaults to about:blank, so
`new_page`+`evaluate` flows on default pages always fail — worth documenting
or fixing the manifest.

## Files
- `adv-17-lib.mjs` — persistent-session MCP client + helpers + test HTTP server
- `adv-17-conc.mjs` — T1/T4/T5
- `adv-17-race.mjs` — T2a/T2b/T3/T8
- `adv-17-time.mjs` — T6/T7
- `adv-17-t8b.mjs` — T8 synthetic-vs-CDP isolation
- `adv-17-slottheft.mjs` — B1 repro
- `adv-17-crashrepro.mjs` — isolated-bridge survival check for B2
