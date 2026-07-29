[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "CodexMobilePwa\app"),
    [switch]$RemoveData
)
$ErrorActionPreference = "Stop"
if (Test-Path (Join-Path $InstallDir "stop.ps1")) { & (Join-Path $InstallDir "stop.ps1") }
Unregister-ScheduledTask -TaskName "Codex Mobile PWA" -Confirm:$false -ErrorAction SilentlyContinue
$dataDir = $null
if (Test-Path (Join-Path $InstallDir "runtime.json")) {
    $dataDir = (Get-Content -Raw (Join-Path $InstallDir "runtime.json") | ConvertFrom-Json).dataDir
}
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveData -and $dataDir) {
    $resolved = [IO.Path]::GetFullPath([string]$dataDir)
    if ($resolved -notlike "$env:LOCALAPPDATA\CodexMobilePwa*") {
        throw "Refusing to remove unexpected data directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Codex Mobile removed. Tailscale Serve configuration was left unchanged."
