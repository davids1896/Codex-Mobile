$ErrorActionPreference = "Continue"
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "runtime.json") | ConvertFrom-Json
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "config.json") | ConvertFrom-Json
$dataDir = [string]$runtime.dataDir
Write-Host "=== Gateway ===" -ForegroundColor Cyan
Test-NetConnection 127.0.0.1 -Port $config.port |
    Select-Object ComputerName, RemotePort, TcpTestSucceeded
(Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($config.port)/" -TimeoutSec 5).StatusCode
Write-Host "`n=== Tailscale Serve ===" -ForegroundColor Cyan
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale -and (Test-Path "C:\Program Files\Tailscale\tailscale.exe")) {
    $tailscale = Get-Item "C:\Program Files\Tailscale\tailscale.exe"
}
if ($tailscale) { & $tailscale.Source serve status } else { Write-Warning "tailscale.exe not found" }
Write-Host "`n=== Autostart ===" -ForegroundColor Cyan
Get-ScheduledTask -TaskName "Codex Mobile PWA" -ErrorAction SilentlyContinue |
    Select-Object TaskName, State
Write-Host "`n=== Codex ===" -ForegroundColor Cyan
& ([string]$config.codexPath) --version
Write-Host "`n=== Pairing code ===" -ForegroundColor Cyan
Get-Content -LiteralPath (Join-Path $dataDir "pairing-code.txt")
