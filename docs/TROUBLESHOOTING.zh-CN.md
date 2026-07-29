# 故障排查

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
