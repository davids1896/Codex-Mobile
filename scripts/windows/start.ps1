$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$runtime = Get-Content -Raw -LiteralPath (Join-Path $root "runtime.json") | ConvertFrom-Json
$config = Get-Content -Raw -LiteralPath (Join-Path $root "config.json") | ConvertFrom-Json
$dataDir = [string]$runtime.dataDir
$env:CODEX_MOBILE_DATA_DIR = $dataDir
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$pidFile = Join-Path $dataDir "gateway.pid"
$stdout = Join-Path $dataDir "gateway.stdout.log"
$stderr = Join-Path $dataDir "gateway.stderr.log"

if (Test-Path -LiteralPath $pidFile) {
    $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
        Write-Host "Codex Mobile is already running (PID $oldPid)."
        exit 0
    }
}

$process = Start-Process -FilePath ([string]$runtime.nodePath) `
    -ArgumentList "`"$root\server.mjs`"" -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -UseBasicParsing `
            -Uri "http://127.0.0.1:$($config.port)/" -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Write-Host "Codex Mobile is ready (PID $($process.Id))."
            exit 0
        }
    } catch {}
}
throw "Gateway did not become ready. Check $stderr"
