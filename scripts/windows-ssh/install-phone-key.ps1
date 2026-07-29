#requires -RunAsAdministrator
[CmdletBinding(DefaultParameterSetName = "Clipboard")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Direct")]
    [string]$PublicKey,

    [Parameter(ParameterSetName = "Clipboard")]
    [switch]$FromClipboard
)

$ErrorActionPreference = "Stop"

if ($PSCmdlet.ParameterSetName -eq "Clipboard") {
    $PublicKey = Get-Clipboard -Raw
}

$PublicKey = $PublicKey.Trim()
if ($PublicKey -notmatch "^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+.*)?$") {
    throw "Clipboard content is not a valid Ed25519 SSH public key. Copy the line beginning with ssh-ed25519, never the private key."
}

$sshDir = Join-Path $env:ProgramData "ssh"
$authorizedKeys = Join-Path $sshDir "administrators_authorized_keys"
if (-not (Test-Path -LiteralPath $sshDir)) {
    throw "OpenSSH Server is not installed or C:\ProgramData\ssh does not exist."
}

if (-not (Test-Path -LiteralPath $authorizedKeys)) {
    New-Item -ItemType File -Path $authorizedKeys -Force | Out-Null
}

$existing = @(Get-Content -LiteralPath $authorizedKeys -ErrorAction SilentlyContinue)
if ($existing -notcontains $PublicKey) {
    Add-Content -LiteralPath $authorizedKeys -Value $PublicKey -Encoding ascii
    Write-Host "Phone public key added." -ForegroundColor Green
} else {
    Write-Host "Phone public key was already installed." -ForegroundColor Yellow
}

& icacls.exe $authorizedKeys /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Failed to apply the required ACL to $authorizedKeys"
}

Restart-Service -Name sshd

Write-Host "`nAuthorized key fingerprints:" -ForegroundColor Cyan
& (Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe") -lf $authorizedKeys
Write-Host "`nConnect with username '$env:USERNAME' to this computer's Tailscale address on port 22." -ForegroundColor Green
