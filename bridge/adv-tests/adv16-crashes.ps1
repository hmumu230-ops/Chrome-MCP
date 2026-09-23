$start = (Get-Date).AddMinutes(-45)
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start; ProviderName='Application Error','Windows Error Reporting'} -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'node\.exe' } |
  Select-Object TimeCreated, Id, @{n='Msg';e={$_.Message.Substring(0,[Math]::Min(500,$_.Message.Length))}} |
  Format-List
