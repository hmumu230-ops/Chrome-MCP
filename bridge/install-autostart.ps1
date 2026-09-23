# Registers Chrome MCP bridge autostart via the per-user Startup folder —
# no admin rights needed (a scheduled task would need elevation).
# Run once:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $bridgeDir 'run-hidden.vbs'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnk = Join-Path $startup 'ChromeMCPBridge.lnk'

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = "`"$vbs`""
$s.WorkingDirectory = $bridgeDir
$s.WindowStyle = 7
$s.Description = 'Chrome MCP bridge supervisor (autostart)'
$s.Save()
Write-Output "Autostart installed: $lnk"
Write-Output 'Bridge supervisor will start (hidden) at next logon. To remove: delete that .lnk file.'
