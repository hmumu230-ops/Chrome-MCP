param([string]$tool, [string]$argsFile, [int]$timeoutMs = 25000)
$env:MCP_ARGS = if ($argsFile -and (Test-Path $argsFile)) { Get-Content $argsFile -Raw } else { $argsFile }
Set-Location D:\Tool\chrome-mcp\bridge
node adv-tests\adv14\call.mjs $tool '{}' $timeoutMs
