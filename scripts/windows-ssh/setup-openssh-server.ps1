#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$TailscaleInterface = "Tailscale",
    [string]$FirewallRuleName = "Codex Mobile SSH via Tailscale"
)

$ErrorActionPreference = "Stop"
$transcriptPath = Join-Path $PSScriptRoot "setup-openssh-server.log"

try {
    Start-Transcript -Path $transcriptPath -Append | Out-Null
} catch {
    Write-Warning "Could not start transcript logging: $($_.Exception.Message)"
}

trap {
    Write-Host "`nSetup failed: $($_.Exception.Message)" -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

Write-Step "Checking Tailscale interface"
$adapter = Get-NetAdapter -Name $TailscaleInterface -ErrorAction Stop
if ($adapter.Status -ne "Up") {
    throw "The Tailscale adapter exists but is not up."
}

Write-Step "Installing Windows OpenSSH Server"
$capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
if ($capability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Host
}

$sshdConfig = Join-Path $env:ProgramData "ssh\sshd_config"
$sshdExe = Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe"
$sshKeygenExe = Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe"
$sshdConfigDefault = Join-Path $env:WINDIR "System32\OpenSSH\sshd_config_default"
if (-not (Test-Path -LiteralPath $sshdConfig)) {
    if (-not (Test-Path -LiteralPath $sshdConfigDefault)) {
        throw "OpenSSH was installed, but neither sshd_config nor sshd_config_default was found."
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $sshdConfig) -Force | Out-Null
    Copy-Item -LiteralPath $sshdConfigDefault -Destination $sshdConfig
}

Write-Step "Backing up and hardening sshd_config"
$backup = "$sshdConfig.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $sshdConfig -Destination $backup

$lines = @(Get-Content -LiteralPath $sshdConfig)
$matchIndex = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*Match\s+") {
        $matchIndex = $i
        break
    }
}

if ($matchIndex -ge 0) {
    $globalLines = @($lines[0..($matchIndex - 1)])
    $matchLines = @($lines[$matchIndex..($lines.Count - 1)])
} else {
    $globalLines = $lines
    $matchLines = @()
}

$optionNames = @(
    "PubkeyAuthentication",
    "PasswordAuthentication",
    "KbdInteractiveAuthentication",
    "PermitEmptyPasswords",
    "AllowAgentForwarding",
    "AllowTcpForwarding",
    "GatewayPorts",
    "X11Forwarding",
    "PermitTunnel",
    "MaxAuthTries",
    "ClientAliveInterval",
    "ClientAliveCountMax"
)

$optionPattern = "^\s*(" + (($optionNames | ForEach-Object { [regex]::Escape($_) }) -join "|") + ")\s+"
$globalLines = @($globalLines | Where-Object { $_ -notmatch $optionPattern })

$hardenedOptions = @(
    "",
    "# Codex mobile access: public-key SSH over Tailscale only.",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no",
    "AllowAgentForwarding no",
    "AllowTcpForwarding no",
    "GatewayPorts no",
    "X11Forwarding no",
    "PermitTunnel no",
    "MaxAuthTries 3",
    "ClientAliveInterval 60",
    "ClientAliveCountMax 3",
    ""
)

$newConfig = @($globalLines + $hardenedOptions + $matchLines)
Set-Content -LiteralPath $sshdConfig -Value $newConfig -Encoding ascii

Write-Step "Generating SSH host keys"
& $sshKeygenExe -A
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backup -Destination $sshdConfig -Force
    throw "SSH host-key generation failed. The original configuration was restored."
}

Write-Step "Hardening SSH host-key permissions"
$systemSid = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
)
$administratorsSid = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
    $null
)
$hostPrivateKeys = Get-ChildItem -LiteralPath (Split-Path -Parent $sshdConfig) -File |
    Where-Object { $_.Name -like "ssh_host_*_key" }

foreach ($hostPrivateKey in $hostPrivateKeys) {
    $keyAcl = New-Object System.Security.AccessControl.FileSecurity
    $keyAcl.SetOwner($administratorsSid)
    $keyAcl.SetAccessRuleProtection($true, $false)
    $keyAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $systemSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )))
    $keyAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $administratorsSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $hostPrivateKey.FullName -AclObject $keyAcl
}

Write-Step "Validating sshd configuration"
& $sshdExe -t -f $sshdConfig
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backup -Destination $sshdConfig -Force
    throw "sshd_config validation failed. The original file was restored."
}

Write-Step "Restricting port 22 to the Tailscale adapter"
$defaultRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($defaultRule) {
    $defaultRule | Disable-NetFirewallRule | Out-Null
}

Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

New-NetFirewallRule `
    -DisplayName $FirewallRuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 22 `
    -InterfaceAlias $TailscaleInterface `
    -RemoteAddress "100.64.0.0/10" `
    -Profile Any | Out-Null

Write-Step "Starting OpenSSH Server"
Set-Service -Name sshd -StartupType Automatic
Restart-Service -Name sshd

Write-Step "Deployment status"
Get-Service -Name sshd | Format-Table Name, Status, StartType
Get-NetFirewallRule -DisplayName $FirewallRuleName |
    Get-NetFirewallPortFilter |
    Format-Table Protocol, LocalPort

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
    $tailscalePath = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path -LiteralPath $tailscalePath) {
        $tailscale = Get-Item -LiteralPath $tailscalePath
    }
}

if ($tailscale) {
    Write-Host "Tailscale IPv4: $(& $tailscale.Source ip -4)" -ForegroundColor Green
}

$hostKey = Join-Path $env:ProgramData "ssh\ssh_host_ed25519_key.pub"
if (Test-Path -LiteralPath $hostKey) {
    Write-Host "SSH host-key fingerprint:" -ForegroundColor Green
    & (Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe") -lf $hostKey
}

Write-Host "`nOpenSSH is ready. Install the phone public key next." -ForegroundColor Green
Write-Host "Backup created at: $backup"
try { Stop-Transcript | Out-Null } catch {}
