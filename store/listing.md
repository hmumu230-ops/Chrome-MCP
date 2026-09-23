# Chrome Web Store 上架材料 — Chrome MCP

## 你需要手动完成的（账号部分）

1. 打开 https://chrome.google.com/webstore/devconsole
2. 用你的 Google 账号登录，同意开发者协议，支付 **$5 一次性注册费**
3. 「New Item」→ 上传 `D:\Tool\chrome-mcp\dist\chrome-mcp-0.1.0.zip`
4. 按下面内容逐项填写后提交审核

## Store listing（商品信息）

**名称**: Chrome MCP

**简短说明** (≤132 字符):
```
Control your real browser from any MCP client — 37 tools for navigation, DOM interaction, screenshots, network capture, and automation via a local bridge.
```

**详细说明**:
```
Chrome MCP turns your actual Chrome browser into an MCP (Model Context Protocol) server. AI assistants and automation tools connect to a local bridge (http://127.0.0.1:7890/mcp) and can drive the browser you're already logged into — with your cookies, sessions, and tabs.

37 tools: tab management, navigation, DOM snapshots, click/fill/keyboard input, screenshots (viewport/full-page/element), network request capture, console logs, cookies, downloads, dialog handling, device emulation, performance tracing, PDF export, and JavaScript evaluation.

Security hardening:
- All file writes are confined to user-chosen paths outside system/protected directories
- Navigation restricted to http(s); file:// and chrome:// are rejected
- Optional token authentication for the local control channel
- Debugger sessions auto-detach when idle

The companion bridge process is required — see the project README. This extension alone does nothing without a local MCP client connection.

Source code: https://github.com/hmumu230-ops/Chrome-MCP
```

**类别**: Developer Tools（开发者工具）

**语言**: English

## 权限理由（Privacy practices 页，逐项填写）

- **debugger**: Required to capture screenshots, record network traffic, emulate devices, handle JavaScript dialogs, and send trusted input events — all core features of the automation surface.
- **tabs / webNavigation**: Required to list, open, navigate, and close tabs on user command.
- **scripting**: Required to read page structure (accessibility/DOM snapshot) and execute JavaScript on user command.
- **cookies**: Required to read and set cookies on user command for automation workflows.
- **downloads**: Required to trigger downloads and list downloads initiated by this extension.
- **alarms**: Used for WebSocket keep-alive and reconnect scheduling.
- **offscreen**: Used for a hidden document to maintain the bridge WebSocket connection.
- **host_permissions <all_urls>**: The tool must be able to read and interact with any page the user navigates to, on user command. It does not run in the background on pages without being invoked.

**数据使用声明**（勾选项）:
- 不收集任何用户数据
- 数据不出本机：扩展只与本机 127.0.0.1 上的桥接进程通信，不连接任何远程服务器
- 用途单一：仅提供本地浏览器自动化接口

**隐私政策 URL**: 需要托管一份。可以直接用 GitHub：在仓库里放 `PRIVACY.md`，URL 填 `https://github.com/hmumu230-ops/Chrome-MCP/blob/main/PRIVACY.md`（内容见下方）。

## 截图要求

至少 1 张，1280x800 或 640x400。建议截图内容：扩展在 chrome://extensions 的卡片 + 一次自动化操作中的页面（例如截图/点击后的效果）。可用我们自己的 take_screenshot 工具生成。

## PRIVACY.md 内容（发布前先提交到仓库）

```markdown
# Privacy Policy — Chrome MCP

Chrome MCP does not collect, transmit, or store any user data outside your own machine.

- The extension communicates exclusively with a local bridge process at 127.0.0.1 (localhost). No data is sent to any remote server, analytics service, or third party.
- All browser data accessed (cookies, page content, screenshots, network traffic) is used solely to fulfill commands issued by your local MCP client, on your machine.
- No telemetry, no tracking, no account required.

Source: https://github.com/hmumu230-ops/Chrome-MCP
Contact: open an issue on the repository.
```

## 审核风险预告（诚实评估）

- `debugger` + `<all_urls>` + `cookies` 是最强权限组合，审核会重点看。描述里强调"本地桥接、用户指令驱动、无数据外发"是过审关键
- 可能被要求补充说明或拒绝（个人自动化工具类扩展有拒审先例）。被拒的话可以申诉或改为"不公开发布（unlisted）"——unlisted 也有正式 extension ID，forcelist 一样能用
- 审核周期通常 1-3 天

## 审核通过后的收尾（我来做）

```powershell
# HKCU 策略，免管理员 —— 发布后告诉我 extension ID，我执行：
New-Item "HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist" -Force
New-ItemProperty "HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist" -Name "1" -PropertyType String -Value "<EXT_ID>;https://clients2.google.com/service/update2/crx"
# Chrome 149+ 对 forcelist 扩展的 DevTools 访问有额外限制，可能还需要：
New-ItemProperty "HKCU:\Software\Policies\Google\Chrome" -Name "DeveloperToolsAvailability" -PropertyType DWord -Value 1 -Force
```

然后移除解包版（chrome://extensions → Remove），重启 Chrome —— 扩展以策略身份安装，横幅免疫，且**只有它免弹，其他扩展的提示不受影响**（比全局参数更精准）。
