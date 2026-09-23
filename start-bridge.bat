@echo off
REM Launch the MCP bridge under the supervisor (auto-restarts on crash).
REM Keep this window open. For autostart at logon: bridge\install-autostart.ps1
cd /d "%~dp0bridge"
node watchdog.mjs
