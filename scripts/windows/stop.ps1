$ErrorActionPreference = "Stop"
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "runtime.json") | ConvertFrom-Json
$pidFile = Join-Path ([string]$runtime.dataDir) "gateway.pid"
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "Codex Mobile is not running."
    exit 0
}
$gatewayPid = [int](Get-Content -LiteralPath $pidFile -Raw)
Stop-Process -Id $gatewayPid -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Codex Mobile stopped."
