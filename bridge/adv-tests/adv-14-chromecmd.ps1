Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.CommandLine -notmatch '--type='} | Select-Object ProcessId,CommandLine | Format-List | Out-String -Width 400
