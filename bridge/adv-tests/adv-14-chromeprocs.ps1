Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.CommandLine -match 'user-data-dir|--type='} | ForEach-Object {
  $ud = if ($_.CommandLine -match '--user-data-dir=([^\s"]+)') { $Matches[1] } else { '(default)' }
  $ty = if ($_.CommandLine -match '--type=([^\s"]+)') { $Matches[1] } else { 'browser' }
  [PSCustomObject]@{Pid=$_.ProcessId; Type=$ty; UserData=$ud}
} | Sort-Object UserData,Type | Format-Table -AutoSize | Out-String -Width 250
