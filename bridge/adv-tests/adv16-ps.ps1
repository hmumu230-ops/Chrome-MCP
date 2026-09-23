$p = Get-Process chrome -ErrorAction SilentlyContinue
if ($p) {
  "chrome procs: " + $p.Count
  "chrome WS GB: " + [math]::Round(($p | Measure-Object WorkingSet64 -Sum).Sum/1GB,2)
} else { "NO CHROME" }
"os free GB: " + [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)
"os total GB: " + [math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,2)
