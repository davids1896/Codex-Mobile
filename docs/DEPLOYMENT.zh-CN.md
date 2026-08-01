# Codex Mobile 详细部署教程

本文从零部署“API Key 留在主机、手机通过 Tailscale 控制 Codex”的完整方案。
Linux 与 Windows 共用同一套 Gateway/PWA，只在自启动方式上不同。

## 1. 前提与边界

主机需要：

- Node.js 20 或更高版本
- 已安装并配置好的 Codex CLI
- Tailscale 已登录并在线
- 一个明确的 Codex 工作区绝对路径
- Git

手机需要：

- Tailscale，登录到同一 Tailnet
- 支持 PWA 的 Safari 或 Chrome

先在主机终端验证：

```bash
node --version
codex --version
codex exec --skip-git-repo-check "Reply only with OK"
tailscale status
```

Windows 使用：

```powershell
node.exe --version
codex.cmd --version
'Reply only with OK' | codex.cmd exec --skip-git-repo-check -
& 'C:\Program Files\Tailscale\tailscale.exe' status
```

必须先看到 Codex 返回 `OK`。PWA 不负责创建、传输或修复 API Key；它直接复用
主机现有的 Codex 配置。

## 2. API Key 与自定义 provider

API Key 认证应在主机 Codex CLI 中完成。一个典型自定义 Responses provider 配置形态为：

```toml
model_provider = "custom"
model = "your-model-id"

[model_providers.custom]
name = "Your Provider"
base_url = "https://your-provider.example"
wire_api = "responses"
requires_openai_auth = true
```

不要把真实 Key 写进本仓库。配置完成后再次运行最小 `codex exec` 测试。

## 3. Linux 部署

### 3.1 克隆与安装

```bash
git clone git@github.com:davids1896/Codex-Mobile.git
cd Codex-Mobile
chmod +x scripts/linux/*.sh
./scripts/linux/install.sh \
  --workspace /home/your-user/code/your-repository
```

可选参数：

```text
--port 8787
--codex /absolute/path/to/codex
--install-dir /custom/app/path
--data-dir /custom/private/data/path
```

默认路径：

```text
应用：~/.local/share/codex-mobile-pwa
数据：~/.config/codex-mobile-pwa
服务：~/.config/systemd/user/codex-mobile-pwa.service
```

安装器会：

1. 复制 Gateway 与 PWA。
2. 写入固定工作区和 Codex 路径。
3. 安装并启动 systemd user service。
4. 设置 `tailscale serve --bg --yes 8787`。
5. 输出配对码和 Tailnet HTTPS 地址。

### 3.2 开机前无登录自启动

systemd user service 默认可能要等用户首次登录。需要无人值守启动时运行：

```bash
sudo loginctl enable-linger "$USER"
```

确认：

```bash
loginctl show-user "$USER" -p Linger
systemctl --user is-enabled codex-mobile-pwa
systemctl --user is-active codex-mobile-pwa
```

### 3.3 验证

```bash
./scripts/linux/verify.sh
```

预期：

- service 为 `active` 与 `enabled`
- 本机 HTTP 返回 `200`
- Tailscale Serve 显示 HTTPS 代理到 `http://127.0.0.1:8787`
- Codex 正常输出版本
- 显示当前配对码

查看日志：

```bash
journalctl --user -u codex-mobile-pwa -f
tail -f ~/.config/codex-mobile-pwa/gateway.log
```

## 4. Windows 部署

### 4.1 克隆与安装

打开普通 PowerShell：

```powershell
git clone git@github.com:davids1896/Codex-Mobile.git
Set-Location .\Codex-Mobile
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\windows\install.ps1 `
  -Workspace 'D:\absolute\path\to\repository'
```

可选参数：

```powershell
.\scripts\windows\install.ps1 `
  -Workspace 'D:\code\repo' `
  -Port 8787 `
  -CodexPath "$env:APPDATA\npm\codex.cmd"
```

默认路径：

```text
应用：%LOCALAPPDATA%\CodexMobilePwa\app
数据：%LOCALAPPDATA%\CodexMobilePwa\data
自启动：计划任务 Codex Mobile PWA
```

安装器会复制文件、生成不含 Key 的 `config.json`、注册登录自启动任务、启动
Gateway，并配置 Tailscale Serve。

### 4.2 验证

```powershell
& "$env:LOCALAPPDATA\CodexMobilePwa\app\verify.ps1"
```

查看错误日志：

```powershell
Get-Content -Wait "$env:LOCALAPPDATA\CodexMobilePwa\data\gateway.stderr.log"
Get-Content -Wait "$env:LOCALAPPDATA\CodexMobilePwa\data\gateway.log"
```

## 5. 手机首次接入

1. 手机安装 Tailscale，并登录同一 Tailnet。
2. 确认目标主机在 Tailscale 中为在线状态。
3. 打开 `tailscale serve status` 输出的 `https://...ts.net` 地址。
4. 输入主机安装器或验证脚本显示的配对码。
5. Safari 中选择“共享” -> “添加到主屏幕”。
6. 从主屏幕打开 Codex Mobile。

配对码不是每次刷新都变化。它在首次启动时生成并持久保存，直到手动轮换。

查询配对码：

```bash
cat ~/.config/codex-mobile-pwa/pairing-code.txt
```

```powershell
Get-Content "$env:LOCALAPPDATA\CodexMobilePwa\data\pairing-code.txt"
```

## 6. 配置多个工作目录与主机

### 6.1 设计原则

- 每台电脑都运行自己的 Codex Mobile Gateway。
- 所有 Gateway 的 `hosts` 列表保持一致。
- 每台主机的 `host.id` 不同，并指向 `hosts` 中自己的条目。
- `workspaces` 只写当前主机上真实存在的绝对目录，各主机可以不同。
- 真实 Tailnet 域名和私有目录只写入安装目录的 `config.json`，不要提交 Git。

这种方式不会把 API Key、附件或 Codex 请求集中到某个中央服务器。选择另一台主机时，网页会直接
跳转到该主机自己的 Tailscale Serve HTTPS 地址。

### 6.2 收集每台主机的 HTTPS 地址

在每台 Linux 主机运行：

```bash
tailscale serve status
```

在 Windows PowerShell 运行：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
```

记录每台主机显示的 `https://...ts.net` 地址。只使用 Serve 地址，不要启用 Funnel。

### 6.3 配置示例

下面仅为占位示例。每台主机都复制同一份 `hosts` 数组，但 `host` 和 `workspaces` 按本机修改：

```json
{
  "port": 8787,
  "workspace": "/home/your-user/code/main-project",
  "workspaces": [
    {
      "id": "main",
      "name": "Main project",
      "path": "/home/your-user/code/main-project"
    },
    {
      "id": "home",
      "name": "Home",
      "path": "/home/your-user"
    }
  ],
  "host": {
    "id": "host-a",
    "name": "Host A",
    "url": "https://host-a.your-tailnet.ts.net"
  },
  "hosts": [
    {
      "id": "host-a",
      "name": "Host A",
      "url": "https://host-a.your-tailnet.ts.net"
    },
    {
      "id": "host-b",
      "name": "Host B",
      "url": "https://host-b.your-tailnet.ts.net"
    }
  ],
  "codexPath": "/absolute/path/to/codex",
  "maxUploadBytes": 26214400,
  "maxAttachments": 8
}
```

旧的单一 `workspace` 配置仍兼容。设置 `workspaces` 后，`workspace` 主要供旧版本和安装器兼容；
网页实际使用白名单中的目录。重新运行安装器会保留已有的 `workspaces`、`host` 和 `hosts`。

### 6.4 修改私有配置

Linux：

```bash
cp -p ~/.local/share/codex-mobile-pwa/config.json \
  ~/.local/share/codex-mobile-pwa/config.json.manual-backup
${EDITOR:-vi} ~/.local/share/codex-mobile-pwa/config.json
systemctl --user restart codex-mobile-pwa
systemctl --user --no-pager --full status codex-mobile-pwa
```

Windows：

```powershell
$app = "$env:LOCALAPPDATA\CodexMobilePwa\app"
Copy-Item "$app\config.json" "$app\config.json.manual-backup" -Force
notepad "$app\config.json"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$app\stop.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$app\start.ps1"
```

如果某个目录不存在、不是绝对路径、ID 重复，Gateway 会拒绝启动，并把具体错误写入日志。

### 6.5 验证切换

1. 打开任意一台主机的网页，确认顶部出现“主机”和“目录”选择器。
2. 切换目录，确认消息视图清空，空白页显示新绝对路径。
3. 新建任务并让 Codex 输出当前目录，确认 cwd 已改变。
4. 切换到“完全访问”，再切目录，确认权限自动恢复为“工作区”。
5. 切换另一台主机，首次输入该主机自己的配对码。
6. 返回原主机，确认原域名的登录会话仍然有效。
7. 重启 Gateway，确认最近一次选择的目录仍被恢复。

## 7. 日常使用

1. 打开手机 Tailscale。
2. 打开 Codex Mobile PWA。
3. 选择历史任务或点击右上角新建任务。
4. 保持“工作区”模式完成常规开发。
5. 需要访问工作区之外的文件时，再临时切换“完全访问”。

附件按钮支持图片与普通文件。图片直接作为视觉输入发送；普通附件保存在主机私有
数据目录，并将本机路径交给 Codex 读取。

## 8. 权限模式

工作区：

- 固定 cwd
- `workspace-write` sandbox
- 对越界操作保留审批流程

完全访问：

- `danger-full-access`
- 不再逐项请求审批
- 仅获得运行 Gateway 的当前用户权限，不会自动获得 root/管理员权限
- Gateway 重启后自动恢复为工作区模式

## 9. 轮换配对码与注销手机会话

Linux：

```bash
./scripts/linux/rotate-pairing-code.sh
```

Windows：

```powershell
& "$env:LOCALAPPDATA\CodexMobilePwa\app\rotate-pairing-code.ps1"
```

脚本会同时轮换 Cookie 签名密钥，因此所有已登录手机都会失效并要求重新配对。

## 10. 更新

```bash
cd Codex-Mobile
git pull --ff-only
./scripts/linux/install.sh --workspace /absolute/path/to/repository
```

Windows：

```powershell
Set-Location .\Codex-Mobile
git pull --ff-only
.\scripts\windows\install.ps1 -Workspace 'D:\absolute\path\to\repository'
```

安装器会保留 Linux 旧配置备份；Windows 会根据参数重新生成配置。更新后重新运行
验证脚本，并在手机上新建一个文字任务和一个图片任务。

## 11. 卸载

Linux，保留配对信息和附件：

```bash
./scripts/linux/uninstall.sh
```

连数据一起删除：

```bash
./scripts/linux/uninstall.sh --remove-data
```

Windows：

```powershell
.\scripts\windows\uninstall.ps1
```

连数据一起删除：

```powershell
.\scripts\windows\uninstall.ps1 -RemoveData
```

卸载器不会自动执行 `tailscale serve reset`，因为该命令可能影响主机上的其他 Serve
配置。确认没有其他服务后再手动调整 Tailscale Serve。

## 12. 部署完成检查表

- [ ] 主机本地 Codex 最小请求成功
- [ ] Gateway 仅监听 `127.0.0.1:8787`
- [ ] systemd/计划任务自启动有效
- [ ] Tailscale Serve 是 Tailnet only HTTPS
- [ ] 手机通过移动网络也能访问
- [ ] 新建文字任务成功
- [ ] 在两个白名单目录之间切换并验证 cwd
- [ ] 在两台主机之间切换并分别完成配对
- [ ] 上传图片并识别成功
- [ ] 普通附件可由 Codex 读取
- [ ] 工作区审批正常
- [ ] 完全访问二次确认正常
- [ ] 重启后权限恢复为工作区
- [ ] 配对码轮换后旧手机会话失效
