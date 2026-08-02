# 手机远程文件编辑器

Codex Mobile 负责对话、任务恢复、附件和审批；`code-server` 提供接近 VS Code 的手机浏览器界面，
用于查看和编辑远程文件、使用终端、搜索代码以及管理 Git。

## 权限边界

`code-server` 以当前 SSH 用户身份运行，因此能访问该用户本来就能访问的所有文件和命令，不局限于
Codex Mobile 的固定工作目录。它不会自动获得 root 权限；需要管理员权限的操作仍需主机原有的
`sudo` 授权。

服务只监听 `127.0.0.1:8080`，外部入口由 Tailscale Serve 发布到 Tailnet-only HTTPS `8443`。
不要把 `8080` 开放到局域网或公网，也不要启用 Tailscale Funnel。

## 一键安装

先确认主机已经安装并登录 Tailscale，然后在仓库目录运行：

```bash
chmod +x scripts/linux/install-code-server.sh
./scripts/linux/install-code-server.sh
```

安装器会：

1. 自动识别 AMD64 或 ARM64。
2. 探测主机自己的 Clash `127.0.0.1:7897`；可用时通过它访问标准 GitHub 地址，否则直连。
3. 下载 GitHub 官方 `code-server 4.131.0` Release 并严格校验 SHA-256。
4. 安装到当前用户的 `~/.local/lib`，随机生成本机密码并以 `600` 权限保存。
5. 创建并启动 `code-server.service` 用户服务。
6. 验证服务、登录页和回环监听，再发布 Tailnet-only HTTPS `8443`。

显式选择网络方式：

```bash
# 禁止代理，直接访问 GitHub
./scripts/linux/install-code-server.sh --proxy none

# 指定主机自己的代理
./scripts/linux/install-code-server.sh --proxy http://127.0.0.1:7897
```

不需要、也不建议把另一台 Windows 电脑的代理写成 Linux 主机的全局代理。跨主机代理只能作为临时
故障后备，否则 Windows 休眠、换网或退出 Clash 后会连带影响远程服务。

## 查询密码

密码只保存在对应主机，不应提交 Git 或发送到聊天。通过电脑查询：

```bash
ssh 3090 'sed -n '"'"'s/^password: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'"'"' ~/.config/code-server/config.yaml'
ssh AGX 'sed -n '"'"'s/^password: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'"'"' ~/.config/code-server/config.yaml'
ssh womoer 'sed -n '"'"'s/^password: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'"'"' ~/.config/code-server/config.yaml'
```

每台主机的密码独立。输入密码后，浏览器会保存该主机自己的登录会话。

## 手机访问

1. 手机连接与主机相同的 Tailscale Tailnet。
2. 在每台主机运行 `tailscale serve status`，找到带 `:8443` 的 Tailnet-only HTTPS 地址。
3. 在手机浏览器打开对应地址，例如：

```text
https://your-host.your-tailnet.ts.net:8443
```

4. 输入该主机自己的 code-server 密码。
5. 使用“打开文件夹”选择该用户有权访问的任意目录。
6. 可将各地址分别添加到手机主屏幕，并以主机名命名。

也可以把上述地址写入该主机私有 `config.json` 的 `host.editorUrl`，并同步到 `hosts` 中对应主机：

```json
"editorUrl": "https://your-host.your-tailnet.ts.net:8443"
```

重启 Gateway 后，Codex Mobile 顶部会出现“代码编辑器”按钮。点击后在当前页面切换到 code-server；
浏览器返回即可回到 Codex Mobile。不要在 `editorUrl` 中嵌入密码、Cookie 或其他凭据。

## 验证与维护

在每台主机运行：

```bash
systemctl --user status code-server.service --no-pager
ss -lnt | grep '127.0.0.1:8080'
curl -I http://127.0.0.1:8080/
curl -I http://127.0.0.1:8080/login
tailscale serve status
```

正确结果应同时满足：

- 服务为 `active`。
- 只出现 `127.0.0.1:8080`，没有 `0.0.0.0:8080`。
- 根路径跳转到 `/login`，登录页可打开。
- `8443` 显示 `tailnet only` 并代理到 `127.0.0.1:8080`。
- 原 Codex Mobile HTTPS 根路径仍代理到 `127.0.0.1:8787`。

升级或修复时重新运行安装脚本即可。已有兼容配置和密码会保留；配置不兼容时脚本会停止，不会静默覆盖。
