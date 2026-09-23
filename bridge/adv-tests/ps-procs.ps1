Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'chrome-mcp|watchdog|index\.js' } |
  Select-Object ProcessId, CreationDate, CommandLine | Format-List
'--- port 7890 ---'
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890 -InformationLevel Quiet -WarningAction SilentlyContinue
