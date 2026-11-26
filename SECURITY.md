# 私下报告安全与隐私问题

内部试用者可以通过项目所有者的私聊发送项目版本、操作系统、受影响的功能和使用合成账号的最小复现。对外托管到 GitHub 时，维护者应启用仓库的 Private vulnerability reporting。启用后，外部报告者可进入仓库的 **Security → Advisories → Report a vulnerability** 提交私密报告。若该入口尚未开放，可先在项目讨论区只询问维护者的私下联系方式。

操作失败时，可在桌面工具栏的工作区面板展开「操作诊断」，输入操作 ID，预览后保存脱敏报告。报告可以包含故障类别、派发记录和已完成步数。请使用虚构凭据及本机测试站复现，并在发送前检查附件。

## 隐私运行检查

默认启动使用严格隐私配置。提交隐私问题时，请附上 `capabilities` 的 `privacy` 字段、系统和 open-browser 版本，以及只含回环地址的最小复现。不要上传 NetLog、截图、Cookie、令牌或真实账号数据。兼容模式只用于对照测试，运行命令为 `OPEN_BROWSER_PRIVACY_PROFILE=compatibility`，问题复现后应恢复默认配置。
