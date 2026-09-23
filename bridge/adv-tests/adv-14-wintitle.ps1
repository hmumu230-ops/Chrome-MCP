Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | Select-Object Id,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200
