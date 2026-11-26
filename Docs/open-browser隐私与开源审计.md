# open-browser 隐私与开源审计

## 开源范围

open-browser 的项目源码、扩展、桌面宿主、构建脚本和测试均在仓库中。项目使用 Apache License 2.0。Playwright Core、MCP SDK、pngjs、Chromium 和 Node.js 按各自许可证和第三方声明分发，详见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。

## 数据边界

- 浏览器使用 open-browser 专用资料目录，与系统 Chrome 用户资料隔离。
- CLI、SDK、MCP 和扩展宿主只通过本机 Unix socket 或 Windows 命名管道通信。
- 工作区只保存页面归属、来源授权、控制代次、脱敏回执和事件游标。页面正文、凭据和截图不会写入诊断数据库。
- 凭据只在服务内存中按工作区和来源保存。观察结果会遮盖已绑定凭据和常见令牌格式。
- 默认严格网络模式按工作区来源授权页面导航和资源请求。被动资源使用不携带 Cookie 或 Authorization 的匿名请求上下文。
- 截图需要独立像素授权。表单、嵌入页面、shadow 宿主和私有标记默认遮盖。
- open-browser 不包含产品遥测、广告脚本或远程账号服务。外部 Agent 看到的页面内容由调用方决定是否继续发送给模型。

## 网络行为

严格模式会限制工作区页面的来源、WebSocket、工作线程和脚本弹窗。`open` 快捷入口保留 Chromium 的正常页面网络，以保证跨来源样式、字体和脚本正常工作，但观察和动作仍绑定到目标工作区与目标来源。

Chromium 自身可能在启动阶段访问其内置服务。当前 macOS 审计曾观察到 `clients2.google.com` 和 `www.google.com` 请求，以及由系统代理产生的 `127.0.0.1:7897` 连接。这些连接来自 Chromium 或本机网络配置，open-browser 不向这些目标发送页面观察结果、凭据、操作回执或截图。若需要完全离线运行，请在操作系统或容器网络层阻断外部连接，并使用本机回环测试站验证功能。

托管模式属于可选部署方式。启用后，协调器只转发经过认证的控制请求和状态元数据，页面正文只在明确的 `observe` 调用中返回给已授权租户，协调器不保存 Cookie、截图、凭据或页面正文。

## 复核命令

```sh
node cli.mjs capabilities
node benchmarks/privacy-audit.mjs
node --test privacy-config.test.mjs observation-boundaries.test.mjs
```

审计夹具只使用回环地址和合成数据，记录 Chromium 网络日志、Node 连接、授权接收端和未授权接收端的连接数与正文长度。原始日志可能包含测试 URL，测试结束后应删除。

## 公开问题

安全或隐私问题请按照 [SECURITY.md](../SECURITY.md) 的私下报告流程提交。报告中应包含版本、平台、复现步骤、实际出站目标和脱敏日志。不要上传真实账号、Cookie、令牌、截图或页面正文。
