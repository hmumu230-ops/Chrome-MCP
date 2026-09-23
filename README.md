# Chrome MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![test](https://github.com/hmumu230-ops/Chrome-MCP/actions/workflows/test.yml/badge.svg)](https://github.com/hmumu230-ops/Chrome-MCP/actions/workflows/test.yml)

把当前这个 Chrome 暴露为通用 MCP server —— 任何支持 MCP 的客户端（Devin、Claude Code、Cursor、ChatGPT、自研 agent…）都连同一个端点，浏览器插件只装一次。

> **English:** Chrome MCP turns your everyday Chrome into a universal [MCP](https://modelcontextprotocol.io) server. A small MV3 extension plus a local Node bridge expose `http://127.0.0.1:7890/mcp` — one Streamable HTTP endpoint that any MCP client can connect to, operating your real tabs, cookies and login sessions. 37 tools: DOM snapshots with element uids, clicking/filling/typing, screenshots, network & console capture, cookies, downloads, PDF export, CDP-powered emulation and performance traces — across iframes, with stale-uid detection and debugger lifecycle management. Docs below are in Chinese; the tool surface and protocol are standard MCP.

## 架构

```
MCP 客户端 ── Streamable HTTP ──▶ bridge (node index.js, :7890)
                                      │ WebSocket :7890/ws
                                      ▼
                              Chrome 扩展 (MV3)
                              ├─ chrome.tabs/scripting → 导航/点击/填表/快照/截图（无横幅）
                              └─ chrome.debugger (CDP) → 网络/控制台/模拟/性能/PDF/弹窗
```

扩展不能接受入站连接，所以必须有一个本地桥进程；桥对客户端暴露标准 MCP，对扩展暴露 WebSocket。

## 安装

```bat
cd bridge
npm install
```

### 1. 启动 bridge

```bat
start-bridge.bat        :: 或 bridge\ 下 npm start
```

环境变量：`MCP_PORT`（默认 7890）、`MCP_CALL_TIMEOUT`（默认 120000ms）、
`MCP_TOKEN`（设了之后 /mcp 要求 `Authorization: Bearer`）、
`MCP_EXT_TOKEN`（非扩展来源的 WS 客户端要求 `?token=`）。
常驻可用 `pm2 start index.js --name browser-mcp` 或任务计划程序。

### 2. 加载扩展

`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 目录。
点工具栏图标可看到桥接状态（绿点 = 已连接）。

> Chrome 137+ 稳定版已移除 `--load-extension` 命令行参数，只能手动加载一次（之后自动生效）。

### 3. 客户端配置（任意 MCP 客户端，统一一个 URL）

| 客户端 | 配置 |
|---|---|
| Claude Code | `claude mcp add --transport http browser http://127.0.0.1:7890/mcp` |
| Devin | `mcp_config.json` → `"browser": { "url": "http://127.0.0.1:7890/mcp" }` |
| Cursor / Windsurf / 其他 | mcp 配置 → `{"url": "http://127.0.0.1:7890/mcp"}` |

## 工具集（37 个）

- **页面**：list_pages, new_page, close_page, select_page, navigate_page, resize_page
- **查看**：take_snapshot（uid 来源，覆盖 iframe）, take_screenshot, evaluate_script, extract_text, wait_for（text / textGone / time，跨 frame）
- **交互**：click（调试器已附着+前台 tab 时自动走 CDP 可信输入）, click_xy, hover, drag, scroll, fill, fill_form, type_text, press_key, upload_file, handle_dialog
- **会话/数据**：get_cookies, set_cookie, remove_cookie, list_downloads, download_file, http_request（带 cookie、免 CORS、支持二进制落盘）, save_pdf
- **调试**：list/get_network_request(s), list/get_console_message(s), emulate, performance_start/stop_trace, detach_debugger

工具带 MCP annotations（readOnlyHint / destructiveHint / idempotentHint / openWorldHint），结果同时返回 text + structuredContent。
变更类操作后自动等页面 settle（轮询 load 状态 + 静默窗口）；页面挂着 JS 弹窗时结果里会带 `modalDialogs` 提醒。

## iframe 支持

`ensureLib` 用 `allFrames: true` 注入所有 frame（含跨域）。`take_snapshot` 遍历 frame 树，
iframe 内元素 uid 形如 `f3xxxxe1`（`f<frameId>` 前缀 + 每文档随机 nonce），交互工具自动路由到对应 frame。

## 安全

- bridge 只绑 `127.0.0.1`；HTTP 校验 Host/Origin（防 DNS rebinding——恶意网页无法 POST 到 /mcp）
- WS 只接受 `chrome-extension://` 来源，且**首个连接的扩展 ID 会被 pin 到 `bridge/.extension-id`**，之后其它扩展一律拒绝；非浏览器来源可用 `MCP_EXT_TOKEN` 控制
- `http_request`/`download_file` 只允许 `http(s)`（`download_file` 另允许 `data:`）——阻止 `file://` 读本地文件
- `navigate_page` 拒绝 `javascript:`/`vbscript:`/`data:` 这类可执行内联内容的 scheme
- `filePath` 输出有防护：Windows 保留名/ADS 拒绝写入；**仓库内已存在文件拒绝覆盖**（防止覆写 bridge/扩展源码）
- 拿到这个端点等于拿到浏览器控制权——**不要**把端口暴露到局域网
- **信任边界说明**：`/ws` 的扩展身份校验能挡住网页和其它扩展（Origin 由浏览器强制），但**无法区分本机进程**——任何能连 127.0.0.1:7890 的本地进程理论上都能冒充扩展（与 Docker socket、`--remote-debugging-port` 同一信任模型）。多用户/不可信本机环境请设置 `MCP_EXT_TOKEN`（非浏览器来源强制 `?token=`）并保持 Chrome 锁定。

## 注意 / 已知边界

- 走 `chrome.debugger` 的工具会让 Chrome 顶部显示「正在调试此浏览器」横幅。**闲置 5 分钟自动 detach**；`detach_debugger` 可手动移除；用户在横幅上点「取消」后该 tab 不再自动重连（导航后解除）。同一 tab 同一时刻只能有一个 debugger（与 DevTools 面板或其它调试扩展互斥），扩展重启留下的僵尸 attach 会自动清扫恢复。
- 调试类收集器与 uid→frame 路由表在页面导航后自动清空；uid 内含每文档随机 nonce，导航后旧 uid 必然报 `stale uid`/`element not found`（不会误点新页面上同位置元素）。页面内 DOM 变化后同样建议重拍。
- 合成事件 `isTrusted=false`；click/press_key 在调试器附着且 tab 前台时自动升级为 CDP `Input.*` 可信输入（Chrome 不向后台 tab 投递 Input 事件）。
- OOPIF（跨进程跨域 iframe）内的 file 上传和 CDP 网络采集不可达（chrome.debugger 只够到主 target；快照/交互不受此限）。
- `evaluate_script` 的 `args` 传元素 uid；多 frame 时用 `frameId` 或首参数 uid 自动定位 frame。
- 隐身窗口需在 `chrome://extensions` 手动开「在隐身模式下启用」，`new_page isolatedContext` 才可用。
- `new_page` 默认 `about:blank` 是无 origin 页面，scripting 不可达——先 `navigate_page` 到真实 URL 再操作。
- `evaluate_script` 返回值经 JSON 序列化：BigInt→`"10n"`、循环引用→`"[Circular]"`、DOM 元素→`"<tag>"`、函数→`"[Function name]"`；async 函数会等待 Promise 结果。
- 未实现：Lighthouse 审计、语义搜索（mcp-chrome 的向量检索）、录制回放、OOPIF flat-session CDP——按需再加。

## 测试

```bat
cd bridge
node smoke-test.mjs    :: 协议冒烟：initialize / tools/list / 未接扩展时的报错
node full-test.mjs     :: 端到端 60 项检查（需 Chrome 已加载扩展），覆盖全部 37 个工具
```

`bridge/adv-tests/` 里是 15 组对抗性测试脚本（协议 fuzz、路径穿越、WS 冒充、竞态、压力等），改安全相关代码后可重跑对应脚本。

CI 在每次 push/PR 自动跑语法检查 + 冒烟测试（`.github/workflows/test.yml`）。
