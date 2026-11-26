# open-browser 第三方组件声明

| 分发组件 | 来源与许可资料 |
| --- | --- |
| Node.js 22.23.5 | 随附 Node 官方归档中的完整 `LICENSE`，包含 Node 与内置第三方库的声明。macOS 位于 `Contents/Resources/node/LICENSE`，便携版位于 `node/LICENSE`。[Node.js 发行目录](https://nodejs.org/dist/v22.23.5/) |
| Playwright Core | Apache License 2.0。应用内 `node_modules/playwright-core/` 包含 `LICENSE`、`NOTICE`、`ThirdPartyNotices.txt`。[Playwright](https://github.com/microsoft/playwright) |
| Chrome for Testing / Chromium | 引擎来自锁定版 Playwright 注册的 Chrome for Testing 构建。open-browser 在 Windows 专用引擎的 chrome.exe 和 chrome.dll 中替换应用图标资源。引擎目录保留对应 ABOUT、组件随附的许可和归属文件。在运行的浏览器中打开 `chrome://credits/` 查看 Chromium 与第三方组件条款。`chrome://version/` 显示产品与版本。[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) · [Chromium 源码许可](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) |
| Model Context Protocol TypeScript SDK | MIT。随附 SDK 包保留其许可文本。[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| pngjs 7.0.0 | MIT。用于在本机解码、遮盖并编码 PNG。完整版权和许可声明随 `node_modules/pngjs/LICENSE` 分发。[pngjs](https://github.com/lukeapage/pngjs) |
| 其他 npm 包 | 每份构建的 `app/third-party-packages.json` 记录实际打入的包路径、版本、声明许可和同目录的许可/归属文件；原始文本随各包分发。macOS 的 app 目录位于 `Contents/Resources/app`。 |

Chrome for Testing 二进制与内含组件各有相应分发条款，公开发行前需按所选平台核对二进制归属、商标及再分发条件。open-browser 自身使用 Apache License 2.0，完整文本见根目录 `LICENSE`。
