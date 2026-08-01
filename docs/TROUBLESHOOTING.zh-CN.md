# 故障排查

## 网页中没有出现其他目录、历史任务或主机

确认正在编辑的是安装目录内的私有配置，而不是仓库中的 `config.example.json`。

Linux：

```bash
${EDITOR:-vi} ~/.local/share/codex-mobile-pwa/config.json
systemctl --user restart codex-mobile-pwa
```

Windows：

```powershell
notepad "$env:LOCALAPPDATA\CodexMobilePwa\app\config.json"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\CodexMobilePwa\app\stop.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\CodexMobilePwa\app\start.ps1"
```

检查每个 `workspaces[].path` 都是本机存在的绝对目录；`id` 必须唯一，并且只能包含字母、数字、
点、下划线和连字符。其他主机的 `hosts[].url` 必须是 Tailscale Serve 提供的 HTTPS 地址。

固定目录只用于新建任务。其他目录来自本机 Codex 的未归档历史任务：打开“历史任务”后等待目录发现完成，
再使用关键词和目录筛选。如果桌面 Codex 与 Gateway 不是同一个系统用户，或使用了不同的 `CODEX_HOME`，
它们不会看到同一套任务。

修改前端后仍看不到选择器时，完全关闭再打开 PWA；必要时删除该 Tailnet 域名的网站缓存。

## 回复只显示 Markdown 文本，图片不显示

先确认手机已加载新前端：粗体应被渲染，而不是显示字面量 `**text**`。如果仍是旧界面，按本文末尾的
Service Worker 步骤清缓存。

图片路径还必须满足：

- 是主机上的绝对路径。
- 文件实际存在，且内容确实是 JPEG、PNG、GIF、WebP 或 AVIF。
- 真实路径位于 `workspaces`、已发现任务目录或 `fileRoots` 中。

检查私有配置中的图片根目录：

```bash
node -e 'const c=require(process.argv[1]); console.log(c.fileRoots)' \
  ~/.local/share/codex-mobile-pwa/config.json
```

Windows：

```powershell
(Get-Content -Raw "$env:LOCALAPPDATA\CodexMobilePwa\app\config.json" |
  ConvertFrom-Json).fileRoots
```

不要为了显示图片把根目录设置成 `/` 或磁盘根目录；优先使用当前用户主目录。

## 选择另一台主机后要求重新输入配对码

这是正常行为。每台主机使用独立域名、Cookie secret 和配对码。首次访问每个主机需要分别配对，
之后浏览器会保存各自的 30 天会话 Cookie。

## `.ts.net` 地址通过代理访问时 TLS 失败

Tailnet 域名和 Tailscale IP 应直接进入 Tailscale，不应发送给普通 HTTP/Clash 上游代理。命令行出现
`SSL/TLS connection failed`、`unexpected eof` 或 HTTP 状态 `000` 时，先绕过代理复测：

```bash
curl --noproxy '*' -I https://your-host.your-tailnet.ts.net
```

如果绕过后正常，把 `.ts.net`、`localhost` 和 `127.0.0.1` 加入本机代理的绕过列表。不要因此把
Tailscale Serve 改成公网 Funnel。

## code-server 无法打开

依次检查：

```bash
systemctl --user status code-server.service --no-pager
ss -lnt | grep '127.0.0.1:8080'
curl -I http://127.0.0.1:8080/login
tailscale serve status
```

`8080` 必须只监听回环地址，`8443` 必须显示 `tailnet only`。若本机页面正常而 HTTPS 不通，检查手机
Tailscale 是否在线，以及 Clash 是否错误代理了 `.ts.net`。详细安装和密码查询见
[手机远程文件编辑器](MOBILE-EDITOR.zh-CN.md)。

## 无法切换工作目录

Gateway 会在以下状态返回 `409`：

- Codex turn 正在运行。
- 有尚未处理的审批或问题。
- 附件仍在上传。

完成或停止当前操作后重试。切换成功后当前任务视图会清空，权限会恢复为“工作区”。

## 手机打不开 HTTPS 地址

按顺序检查：

```bash
systemctl --user is-active codex-mobile-pwa
curl -I http://127.0.0.1:8787/
tailscale status
tailscale serve status
```

Windows：

```powershell
& "$env:LOCALAPPDATA\CodexMobilePwa\app\verify.ps1"
```

不要把 Gateway 改成监听 `0.0.0.0`。本机 HTTP 正常但手机失败时，应处理 Tailscale
设备登录、Tailnet ACL、MagicDNS 或 Serve，而不是开放公网端口。

## 配对码在哪里，是否动态

配对码首次启动时随机生成，默认保持不变。

Linux：

```bash
cat ~/.config/codex-mobile-pwa/pairing-code.txt
```

Windows：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexMobilePwa\data\pairing-code.txt"
```

需要失效旧会话时使用轮换脚本，不要只手工修改文本。

## `Model metadata for ... not found`

这通常发生在自定义 provider 使用了 Codex 内置目录之外的模型 ID。Codex 会退回
保守元数据，可能导致上下文、推理档位或图片能力判断错误。

在 `.codex/config.toml` 中增加模型目录：

```toml
model_catalog_json = "your-model-catalog.json"
```

并把目录文件放到：

```text
Linux:   ~/.codex/your-model-catalog.json
Windows: %USERPROFILE%\.codex\your-model-catalog.json
```

目录中必须存在当前模型 ID，并正确声明其上下文窗口、推理档位和
`input_modalities`。重启 Gateway 后新建任务测试：

```bash
systemctl --user restart codex-mobile-pwa
```

如果当前 Codex CLI 不识别 `model_catalog_json`，升级 CLI 后重试。不要把带有私有
provider 信息的模型目录直接提交到公共仓库。

## 文字任务成功，但图片任务卡住

先区分两层：

1. 页面能否上传文件并在消息中显示缩略图。
2. provider/model 是否真正接受图片输入。

检查目录是否为模型声明了图片：

```json
"input_modalities": ["text", "image"]
```

再直接绕过 PWA 做最小图片测试：

```bash
codex exec --ephemeral --skip-git-repo-check \
  -i /absolute/path/to/test.png \
  "Reply only with IMAGE_OK if the image is visible."
```

若文字成功、图片仍超时，重点检查自定义 provider 的 Responses API 图片兼容性和
上游超时，而不是反复重装 PWA。

## Gateway 显示 Codex app-server exited

```bash
codex --version
codex app-server --help
journalctl --user -u codex-mobile-pwa -n 100 --no-pager
```

Windows 检查 `config.json` 中的 `codexPath` 是否仍存在。Node 或 Codex 安装位置
变化后，重新执行安装器即可刷新路径。

## Linear MCP `Missing or invalid access token`

这是 Linear 插件未授权，与 Gateway、配对码和模型目录无关。不使用 Linear 时可在
Codex 配置中禁用对应插件；需要使用时按 Codex 客户端的授权流程登录。

## `curl` 或 `codex` 在 systemd 中找不到

交互式 shell 与 systemd 的 PATH 不同。重新运行 Linux 安装器，它会把实际 Node 和
Codex 目录写入 service 的 PATH，并使用绝对 ExecStart。

## 修改代码后手机仍显示旧界面

PWA 使用 Service Worker 缓存。依次尝试：

1. 完全关闭并重新打开 PWA。
2. Safari 网站数据中删除该 Tailnet 域名的缓存。
3. 开发者修改前端资源时同步提升 `sw.js` 的缓存版本与 `index.html` 查询参数。

## 查看日志

Linux：

```bash
journalctl --user -u codex-mobile-pwa -f
tail -f ~/.config/codex-mobile-pwa/gateway.log
```

Windows：

```powershell
Get-Content -Wait "$env:LOCALAPPDATA\CodexMobilePwa\data\gateway.stderr.log"
Get-Content -Wait "$env:LOCALAPPDATA\CodexMobilePwa\data\gateway.log"
```

分享日志前先删除 Key、Token、Cookie、配对码、私人路径和附件内容。
