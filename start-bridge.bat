@echo off
REM Launch the MCP bridge. Keep this window open (or run via pm2/Task Scheduler for autostart).
cd /d "%~dp0bridge"
node index.js
