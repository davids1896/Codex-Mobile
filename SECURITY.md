# Security

## 安全边界

Gateway 只监听 `127.0.0.1`。远程访问必须经过 Tailscale Serve，项目不支持也不建议
将 Gateway 直接绑定到局域网或公网地址。

手机认证由两层组成：

1. Tailscale Tailnet 身份与设备授权。
2. Gateway 配对码换取的签名、HttpOnly、Secure、SameSite=Strict Cookie。

配对码首次启动时随机生成，此后保持不变，直到手动轮换。会话默认有效 30 天。

## 秘密处理

不要提交或分享：

- Codex API Key 与 `auth.json`
- `.codex/config.toml`
- 自定义模型目录
- `pairing-code.txt`
- `cookie-secret.txt`
- 上传附件与日志

## 完全访问

完全访问模式相当于让手机端任务以启动 Gateway 的系统用户权限运行，并取消逐项
审批。它不是管理员提权，但该用户本来能访问的文件和命令都会暴露给任务。

仅在明确需要时开启。完成高权限操作后切回工作区模式。重启 Gateway 也会自动复位。

## 失窃响应

手机、Tailnet 账号或配对码疑似泄漏时：

1. 从 Tailscale 管理后台移除或禁用相关设备。
2. 运行平台对应的 `rotate-pairing-code` 脚本。
3. 检查 Gateway 日志和 Codex 任务历史。
4. 如 API Key 可能泄漏，在 provider 后台轮换 Key。

## 报告问题

提交安全问题时不要附带真实 Key、配对码、Cookie、Tailnet 域名或私人附件。
