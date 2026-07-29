$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "stop.ps1")
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "runtime.json") | ConvertFrom-Json
$dataDir = [string]$runtime.dataDir
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($name in "pairing-code.txt", "cookie-secret.txt") {
    $path = Join-Path $dataDir $name
    if (Test-Path -LiteralPath $path) {
        Move-Item -LiteralPath $path -Destination "$path.backup-$stamp"
    }
}
& (Join-Path $PSScriptRoot "start.ps1")
Write-Host "New pairing code:"
Get-Content -LiteralPath (Join-Path $dataDir "pairing-code.txt")
