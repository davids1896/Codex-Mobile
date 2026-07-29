[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "CodexMobilePwa\app"),
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "CodexMobilePwa\data"),
    [int]$Port = 8787,
    [string]$CodexPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$gatewaySource = Join-Path $repoRoot "gateway"
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$node = Get-Command node.exe -ErrorAction Stop
if (-not $CodexPath) {
    $CodexPath = (Get-Command codex.cmd -ErrorAction Stop).Source
} else {
    $CodexPath = (Resolve-Path -LiteralPath $CodexPath).Path
}

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
Copy-Item -Path (Join-Path $gatewaySource "*") -Destination $InstallDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "start.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "stop.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "verify.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "rotate-pairing-code.ps1") -Destination $InstallDir -Force

$utf8 = New-Object System.Text.UTF8Encoding($false)
$config = [ordered]@{
    port = $Port
    workspace = $workspacePath
    codexPath = $CodexPath
    maxUploadBytes = 26214400
    maxAttachments = 8
} | ConvertTo-Json
$runtime = [ordered]@{
    dataDir = [IO.Path]::GetFullPath($DataDir)
    nodePath = $node.Source
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), $config, $utf8)
[IO.File]::WriteAllText((Join-Path $InstallDir "runtime.json"), $runtime, $utf8)

$taskName = "Codex Mobile PWA"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
    "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`"" -f
    (Join-Path $InstallDir "start.ps1")
)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

& (Join-Path $InstallDir "start.ps1")
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale -and (Test-Path "C:\Program Files\Tailscale\tailscale.exe")) {
    $tailscale = Get-Item "C:\Program Files\Tailscale\tailscale.exe"
}
if ($tailscale) {
    & $tailscale.Source serve --bg --yes $Port
}

Write-Host "`nCodex Mobile installed." -ForegroundColor Green
Write-Host "Pairing code: $(Get-Content -LiteralPath (Join-Path $DataDir 'pairing-code.txt') -Raw)"
if ($tailscale) { & $tailscale.Source serve status }
