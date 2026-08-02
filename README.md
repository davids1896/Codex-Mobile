# Codex Mobile

通过 Tailscale 在手机上安全控制主机中的 Codex CLI。项目提供一个轻量 PWA，
把 Codex `app-server` 的任务、审批、附件和权限控制能力映射到手机浏览器。

> 本项目是非官方社区工具，使用 Codex CLI 的实验性 `app-server` 协议。
> Codex CLI 升级后可能需要同步适配。

## 功能

- 新建、恢复和停止 Codex 任务
- 实时显示回复、命令执行和文件变更
- 安全渲染 Markdown、代码块、链接和主机本地图片
- 在手机端处理命令审批与问题输入
- 每条消息默认上传 8 个、单个最大 25 MB 的图片或附件
- 自动发现本机 Codex 历史任务及其工作目录，并支持标题、摘要、消息正文关键词搜索和目录筛选
- 在配置目录与历史任务目录之间切换；最近的固定目录选择会在 Gateway 重启后恢复
- 在同一个网页界面中切换多台独立主机
- 工作区模式与完全访问模式切换
- 同一台主机可同时运行多个任务，切换任务不会停止后台工作
- 任务运行中可继续发送消息，使用 Codex 原生 steering 引导当前轮次
- 可在私有配置中选择默认进入工作区或完全访问模式
- 任务完成后通过 Web Push 通知手机
- 向上查看长对话时显示“返回底部”按钮
- 配对码登录、30 天签名会话
- Windows 计划任务与 Linux systemd user service 自启动
- Tailscale Serve 提供 Tailnet 内 HTTPS，不开放公网端口
- 可选部署 Tailnet-only `code-server`，在手机查看和编辑该用户可访问的全部远程文件
- 可在 Codex Mobile 顶部点击“代码编辑器”，切换到当前主机的 Tailnet-only `code-server`

## 架构

```mermaid
flowchart LR
    P["手机 Safari / PWA"] -->|"Tailnet HTTPS"| T["Tailscale Serve"]
    T -->|"127.0.0.1:8787"| G["Node.js Gateway"]
    T -->|"可选 127.0.0.1:8080"| E["code-server"]
    G -->|"JSON-RPC over stdio"| C["Codex app-server"]
    C --> W["白名单工作区"]
    C --> A["主机上的 API Key / provider 配置"]
```

API Key、`auth.json`、自定义 provider 配置和模型目录始终留在主机。手机只持有
Tailnet 身份与网关会话 Cookie。

多主机使用联邦式部署：每台主机运行自己的 Gateway 和 Codex，网页选择主机时跳转到该主机的
Tailnet HTTPS 地址。各主机的 API Key、配对码、Cookie、附件和任务数据互不转发。

## 快速安装

准备好 Node.js、Codex CLI、Tailscale，并先确认主机上直接运行 Codex 可以正常回复。

Linux：

```bash
git clone git@github.com:davids1896/Codex-Mobile.git
cd Codex-Mobile
chmod +x scripts/linux/*.sh
./scripts/linux/install.sh --workspace /absolute/path/to/repository
```

Windows PowerShell：

```powershell
git clone git@github.com:davids1896/Codex-Mobile.git
cd Codex-Mobile
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\windows\install.ps1 -Workspace 'D:\path\to\repository'
```

安装器会启动网关、配置自启动、调用 `tailscale serve --bg`，并输出手机首次登录
所需的配对码。然后在手机 Tailscale 中连接同一 Tailnet，打开安装器显示的 HTTPS
地址，并将页面添加到主屏幕。

安装后编辑私有 `config.json` 即可增加 `workspaces`、带可选 `editorUrl` 的 `hosts`、
可显示图片的 `fileRoots` 与默认权限模式。完整格式和多主机同步步骤见
[详细部署教程](docs/DEPLOYMENT.zh-CN.md#6-配置多个工作目录与主机)。

## 文档

- [详细部署教程](docs/DEPLOYMENT.zh-CN.md)
- [手机远程文件编辑器](docs/MOBILE-EDITOR.zh-CN.md)
- [架构与数据流](docs/ARCHITECTURE.md)
- [故障排查](docs/TROUBLESHOOTING.zh-CN.md)
- [安全策略](SECURITY.md)
- [Windows SSH 兜底方案](docs/WINDOWS-SSH.zh-CN.md)

## 重要安全提醒

- 不要使用 Tailscale Funnel，不要做公网端口映射。
- 不要把 API Key、`auth.json`、配对码或 Cookie 密钥提交到 Git。
- “完全访问”会关闭逐项审批并允许 Codex 以当前系统用户权限访问整台主机。
- 公开安装默认使用“工作区”；如需默认完全访问，只在主机私有配置中设置
  `"defaultPermissionMode": "full"`。
- Web Push 订阅和 VAPID 私钥只保存在每台主机的私有数据目录。
- 怀疑配对码或手机会话泄漏时，应立即运行配对码轮换脚本。

## License

MIT
