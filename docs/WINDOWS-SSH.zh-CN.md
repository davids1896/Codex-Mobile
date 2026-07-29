# Windows SSH 兜底方案

PWA 是主要手机界面。SSH 方案适合 PWA 故障排查、恢复服务或需要完整终端时使用。
SSH 仍然只通过 Tailscale，不做路由器端口映射。

## 1. 安装 OpenSSH Server

以管理员身份打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\windows-ssh\setup-openssh-server.ps1
```

脚本会：

- 安装并自动启动 Windows OpenSSH Server
- 关闭密码和键盘交互认证
- 只允许公钥认证
- 禁用 SSH 转发、隧道和 X11
- 将端口 22 防火墙规则限制到 Tailscale 网卡和 `100.64.0.0/10`
- 输出服务器 Ed25519 指纹

## 2. 手机生成密钥

在 Termius 等支持 Ed25519 的 SSH 客户端中生成新密钥。私钥只保存在手机安全存储，
并设置口令或生物识别。只复制一行以 `ssh-ed25519` 开头的公钥。

## 3. 安装手机公钥

把公钥放入 Windows 剪贴板，然后在管理员 PowerShell 中运行：

```powershell
.\scripts\windows-ssh\install-phone-key.ps1 -FromClipboard
```

管理员用户的公钥会写入：

```text
C:\ProgramData\ssh\administrators_authorized_keys
```

脚本会应用 Windows OpenSSH 所要求的 ACL。

## 4. 手机连接

```text
Host: 主机的 Tailscale IPv4 或 MagicDNS 名称
Port: 22
Username: Windows 用户名
Authentication: 手机生成的 Ed25519 私钥
```

首次连接必须核对服务器指纹。

进入 PowerShell：

```powershell
powershell -NoLogo -NoProfile
```

启动或恢复 Codex：

```powershell
codex.cmd -C 'D:\absolute\path\to\repository' --no-alt-screen
codex.cmd resume --all --no-alt-screen
codex.cmd resume --last --no-alt-screen
```

不要在桌面端和 SSH 手机端同时推进同一个任务。

## 5. 验证

```powershell
.\scripts\windows-ssh\verify-codex-mobile-ssh.ps1 `
  -Workspace 'D:\absolute\path\to\repository'
```

最终测试应关闭手机 Wi-Fi、使用移动网络连接，以确认流量确实经过 Tailscale。
