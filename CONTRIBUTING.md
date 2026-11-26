# 参与 open-browser

从项目根目录运行以下命令。使用 Node.js 22.23.5 或更新的受支持版本、npm 和本机 Chromium 所需系统库。

```sh
npm ci
npm run browser:install
node --test service.integration.test.mjs
```

这个用例启动临时本机服务，通过 CLI 创建工作区，再用 MCP 观察本机登录站。它使用独立资料与合成账号。失败输出包含测试名和断言位置。遇到引擎启动错误时，先检查安装命令的输出；Linux 可运行 `node node_modules/playwright-core/cli.js install-deps chromium` 补齐系统库。

修改控制接口时，更新方法描述、SDK 类型和项目内 Skill。用 `node cli.mjs --schema` 查看 CLI、MCP 与服务使用的方法描述。修改任务执行时，请给出站点收到的结果、执行前后所用场景和复跑命令。截图、账号资料、令牌与真实站点正文留在本机。

快速回归使用 `npm run test:unit`，合并前使用 `npm run test:all`。桌面签名、目标平台打包和 SHA-256 核对步骤见[跨平台试用与发行](Docs/跨平台试用与发行.md)。本地评测口径见[任务评测指南](Docs/open-browser任务评测指南.md)。安全或隐私问题请按[私下报告流程](SECURITY.md)联系维护者。
