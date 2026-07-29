[CmdletBinding()]
param(
    [string]$Workspace
)

$ErrorActionPreference = "Continue"
$tailscalePath = "C:\Program Files\Tailscale\tailscale.exe"
$codex = Get-Command codex.cmd -ErrorAction SilentlyContinue

Write-Host "=== OpenSSH service ===" -ForegroundColor Cyan
Get-Service -Name sshd -ErrorAction SilentlyContinue |
    Format-Table Name, Status, StartType

Write-Host "`n=== Local port 22 ===" -ForegroundColor Cyan
Test-NetConnection -ComputerName 127.0.0.1 -Port 22 |
    Select-Object ComputerName, RemotePort, TcpTestSucceeded |
    Format-Table

Write-Host "`n=== Tailscale ===" -ForegroundColor Cyan
if (Test-Path -LiteralPath $tailscalePath) {
    & $tailscalePath status
    Write-Host "IPv4: $(& $tailscalePath ip -4)"
} else {
    Write-Warning "Tailscale executable not found."
}

Write-Host "`n=== Firewall ===" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "Codex Mobile SSH via Tailscale" -ErrorAction SilentlyContinue |
    Format-Table DisplayName, Enabled, Direction, Action, Profile

Write-Host "`n=== SSH host fingerprint ===" -ForegroundColor Cyan
$hostKey = Join-Path $env:ProgramData "ssh\ssh_host_ed25519_key.pub"
if (Test-Path -LiteralPath $hostKey) {
    & (Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe") -lf $hostKey
} else {
    Write-Warning "SSH Ed25519 host key not found."
}

Write-Host "`n=== Codex CLI ===" -ForegroundColor Cyan
if ($codex) {
    & $codex.Source --version
    if ($Workspace) {
        Write-Host "New task:"
        Write-Host "  codex.cmd -C `"$Workspace`" --no-alt-screen"
    }
    Write-Host "Resume task: codex.cmd resume --all --no-alt-screen"
} else {
    Write-Warning "codex.cmd not found in PATH."
}
