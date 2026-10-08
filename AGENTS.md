# AGENTS.md — Chrome MCP

## Runtime

- Bridge: `http://127.0.0.1:7890/mcp` (status: `GET /`), runs under `bridge/watchdog.mjs` (auto-restart, flap cooldown). Start: `start-bridge.bat` or logon autostart via `ChromeMCPBridge.lnk` in the Startup folder.
- Extension: unpacked MV3 at `extension/`, loaded in Chrome **Default profile ("mu")** only. Reload via `chrome://extensions` after editing.

## House rules (user preferences)

- **Always launch Chrome with `--profile-directory="Default"`** when spawning chrome.exe directly (e.g. to open `chrome://*` pages the MCP can't navigate to). Other profiles must not be used for automation. Prefer MCP tools whenever the mu window is up — the extension is bound to Default, zero ambiguity.
- Never weaken `writeOut` protected-path policy (repo root, Windows dir, Startup dirs) to make a test pass.
- Don't commit `extension/.bridge-token`, `dist/`, or adv-test run artifacts (`*-results.*`, `*-log*.txt`, `out*.json`, `*.sid`).

## Verification gates

- `node bridge/adv-tests/writeout-verify.mjs` — file-write protection (21 checks; script creates its own fixtures)
- `node bridge/adv-tests/round2-regress.mjs` — round-2 regression suite (25 checks)
- `node bridge/adv-tests/round3-regress.mjs` — production-log regression (14 checks: frozen-renderer recovery, session eviction, string pageId)
- `node bridge/full-test.mjs` — end-to-end suite (61 checks; 1 known limitation: incognito needs "Allow in incognito")

## Known limitations

- Navigation restricted to http(s)/about:blank; `file:`/`chrome:`/`data:`/`blob:` rejected by design.
- **Frozen renderers**: Chrome freezes background-tab renderers (minimized/occluded windows, ~5min memory-saver idle). `executeScript` and `chrome.debugger` IPC then queue forever. `withRenderedTab()` (cdp.js) unminimizes + briefly activates the tab, runs the work, restores prior state — calls on frozen tabs show a ~1s tab flicker by design. `fromSurface:false` is NOT a screenshot fallback: headed Chrome 153+ rejects it (-32000).
- Session pool: `MAX_SESSIONS=50` evicts least-recently-used instead of 503. If a client loses its session mid-work its next request gets 404 → it must re-`initialize` (spec convention).
- Debugger infobar: suppressed via `--silent-debugger-extension-api` on launch (taskbar shortcut already configured) or idle auto-detach (60s). User clicking "Cancel" bans auto-reattach for that tab.
- Chrome + Edge both loading this extension share the single WS slot — incumbent-wins by design.
- Gotcha: `chrome.exe ... chrome://page` command-line args are ignored when Chrome is already running (chrome:// URLs are filtered in the running-instance handoff) — type chrome:// URLs via the omnibox or open them from a page.
