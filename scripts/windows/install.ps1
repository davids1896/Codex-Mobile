[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "CodexMobilePwa\app"),
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA "CodexMobilePwa\data"),
    [int]$Port = 8787,
    [string]$CodexPath,
    [string[]]$FileRoot = @()
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
if (Test-Path -LiteralPath (Join-Path $InstallDir "config.json")) {
    Copy-Item -LiteralPath (Join-Path $InstallDir "config.json") `
        -Destination (Join-Path $InstallDir ("config.json.backup-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))) `
        -Force
}
Copy-Item -Path (Join-Path $gatewaySource "*") -Destination $InstallDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "start.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "stop.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "verify.ps1") -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "rotate-pairing-code.ps1") -Destination $InstallDir -Force

$utf8 = New-Object System.Text.UTF8Encoding($false)
$existingConfig = $null
$installedConfigPath = Join-Path $InstallDir "config.json"
if (Test-Path -LiteralPath $installedConfigPath) {
    try {
        $existingConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $installedConfigPath |
            ConvertFrom-Json
    } catch {}
}
$workspaceName = Split-Path -Leaf $workspacePath
if (-not $workspaceName) { $workspaceName = $workspacePath }
$workspaces = @(
    if ($existingConfig -and $existingConfig.workspaces.Count -gt 0) {
        $existingConfig.workspaces
    } else {
        [ordered]@{ id = "default"; name = $workspaceName; path = $workspacePath }
    }
)
if (-not ($workspaces | Where-Object { [string]$_.path -eq $workspacePath })) {
    $workspaces += [ordered]@{
        id = "workspace-$($workspaces.Count + 1)"
        name = $workspaceName
        path = $workspacePath
    }
}
$defaultHostId = ([regex]::Replace($env:COMPUTERNAME.ToLowerInvariant(), "[^a-z0-9._-]", "-")).Trim("-")
if (-not $defaultHostId) { $defaultHostId = "windows-host" }
$host = if ($existingConfig -and $existingConfig.host) {
    $existingConfig.host
} else {
    [ordered]@{ id = $defaultHostId; name = $env:COMPUTERNAME; url = "" }
}
$hosts = @(
    if ($existingConfig -and $existingConfig.hosts.Count -gt 0) {
        $existingConfig.hosts
    } else {
        $host
    }
)
$fileRoots = @(
    if ($existingConfig -and $existingConfig.fileRoots.Count -gt 0) {
        $existingConfig.fileRoots
    }
)
foreach ($root in $FileRoot) {
    $resolvedRoot = (Resolve-Path -LiteralPath $root).Path
    if (-not ($fileRoots | Where-Object {
        [string]::Equals([string]$_, $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)
    })) {
        $fileRoots += $resolvedRoot
    }
}
if ($fileRoots.Count -eq 0) {
    $fileRoots = @((Resolve-Path -LiteralPath $env:USERPROFILE).Path)
}
$maxUploadBytes = if ($existingConfig -and $existingConfig.maxUploadBytes) {
    [int64]$existingConfig.maxUploadBytes
} else {
    26214400
}
$maxAttachments = if ($existingConfig -and $existingConfig.maxAttachments) {
    [int]$existingConfig.maxAttachments
} else {
    8
}
$config = [ordered]@{
    port = $Port
    workspace = $workspacePath
    workspaces = $workspaces
    host = $host
    hosts = $hosts
    codexPath = $CodexPath
    fileRoots = $fileRoots
    maxUploadBytes = $maxUploadBytes
    maxAttachments = $maxAttachments
} | ConvertTo-Json -Depth 6
$runtime = [ordered]@{
    dataDir = [IO.Path]::GetFullPath($DataDir)
    nodePath = $node.Source
} | ConvertTo-Json
[IO.File]::WriteAllText($installedConfigPath, $config, $utf8)
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
