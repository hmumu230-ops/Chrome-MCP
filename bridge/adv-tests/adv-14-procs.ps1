Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CreationDate,CommandLine | Format-List | Out-String -Width 300
