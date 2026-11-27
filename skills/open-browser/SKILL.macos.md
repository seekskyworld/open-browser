[open-browser:skill] open-browser usage guide (macOS)

---
name: open-browser
description: 用户要求用 open-browser 浏览、观察页面、操作工作区或验证登录时，通过 open-browser CLI 控制其独立 Chromium。
---

在 macOS 和 Linux 使用本 Skill 目录内的 `scripts/open-browser`，在 Windows 使用 `scripts/open-browser.cmd`。便携包中的 Skill 位于 `app/skills/open-browser/`，其启动脚本使用包内 Node。下文以 `$ob` 表示它的绝对路径。命令名是第一个参数，其余参数从标准输入读取 JSON，标准输出也是 JSON。运行 `"$ob" --help` 查看方法。首次调用会探测本机服务，必要时自动启动 open-browser 应用或便携包并等待就绪后重试一次。设置 `OPEN_BROWSER_AUTOSTART=0` 可关闭自动启动。该引导只使用本机 socket 或命名管道，不需要配置 MCP 地址。连续任务可运行 `"$ob" session`，它按行读取 `{\"id\":1,\"method\":\"observe\",\"params\":{...}}`，复用同一个 Node 客户端直到标准输入关闭。

## 最短路径

一次性打开并读取页面时，优先使用 `open`，它会创建工作区、打开明确网址并返回页面句柄。随后把句柄传给 `observe`，再把最新观察中的 `documentId` 和 `controlGeneration` 传给 `act`。任务完成后调用 `finishWorkspace`，将需要交付的页面放进 `keepPageIds`。

```sh
ob="$PWD/skills/open-browser/scripts/open-browser"
page=$(printf '%s\n' '{"url":"https://example.org","name":"页面检查"}' | "$ob" open)
printf '%s\n' "$page"
# 从上一个 JSON 结果取 workspaceId 和 pageId，再执行 observe
printf '%s\n' '{"workspaceId":"WORKSPACE_ID","pageId":"PAGE_ID"}' | "$ob" observe
```

多步骤任务使用 `createWorkspace` 和 `openPage`，因为它们允许你明确设置 `allowedOrigins` 与 `resourceOrigins`。调用 `capabilities` 可先查看当前服务版本、限额、隐私模式及可用视觉动作。

遇到错误时按返回的 `code` 和 `nextAction` 处理。`stale_ref`、`stale_document`、`stale_control` 和 `stale_observation` 先重新 `observe`。`target_ambiguous` 用 `observe.locator` 缩小范围。`target_obscured` 等待遮罩消失后用新的操作号重试。`origin_denied` 先核对 `blockedOrigins`，取得工作区控制权后再用 `grantOrigin`。`human_verification_required` 表示站点要求安全验证，停止重试，调用 `handOff`，让用户在可见页面完成验证后再调用 `returnToAgent` 并重新 `observe`。`REQUEST_TIMEOUT`、`run_timeout`、`outcome_unknown` 或 `inspect_before_retry` 先用同一个 `operationId` 查询回执并核对站点结果。

若只使用 SDK，可用 `openAndObserve` 省去首次句柄拼接，用 `observeAndAct` 或 `actAfterObserve` 在一次服务请求中完成最新观察和动作提交，用 `finish` 自动生成交付操作号。这些辅助方法仍执行服务端的工作区权限、来源和过期引用检查。连续任务优先复用同一个 SDK 客户端，避免每个动作重新启动 CLI。

1. 运行 `"$ob" listWorkspaces </dev/null`。继续已有任务时使用该任务的工作区。新任务通过 `createWorkspace` 创建，必须填写清晰的 `name` 任务名称，并保存返回的 `workspaceId`。`name` 填任务名称，`agentName` 填创建者的显示名（最多 80 个 Unicode 码点）。多个子代理并行时，每个子代理须显式传自己的名字。同一客户端的子代理通常共享环境或 MCP 握手，只能由子代理自身区分身份。
2. 调用 `openPage`，传入 `workspaceId` 和目标 `url`，保存返回的页面句柄。把完整句柄传给 `observe`，读取可见文本、元素的 `role/name/ref`、`documentId` 和 `controlGeneration`。
3. 调用 `act`，把页面句柄、刚取得的两个代次标识、唯一 `operationId` 和有序的 `actions` 放入同一个 JSON 对象。例如动作可为 `{"kind":"fill","ref":"实际输入框引用","value":"待填写的普通文本"}` 和 `{"kind":"click","ref":"实际按钮引用"}`。相同控件在连续观察中保留引用。节点被移除或替换后，收到 `stale_ref` 时重新观察并核对目标。可见标签返回 `role:"label"` 时用 `click` 勾选关联控件。密码使用 `fillCredential` 和当前工作区、站点已绑定的 `credentialRef`。
4. 对 `queued` 或 `running` 回执，使用同一个 `operationId` 和 `workspaceId` 调用 `getOperation`，直至终态。再次 `observe` 核对页面业务结果。若结果为 `outcome_unknown`，先核对页面；导航或用户交回控制权后，重新观察再构造新动作。
5. 已有会话或凭据可用时自动继续；缺少凭据时只提示缺少的引用，用户在浏览器工具栏的 **open-browser 工作区** 扩展中核对站点并点 **绑定凭据** 后继续。需要用户操作时用 `handOff`。在 macOS 桌面应用中，用户可点击受管页面底部的「人工接管」和「交回 Agent」。工具栏也可切换控制权；缺凭据时可从弹出的面板接管。接管覆盖整个工作区，用户点 **交回 Agent** 后重新观察。整项任务完成后，Agent 在向用户报告前调用 `finishWorkspace`，将结果页放入 `keepPageIds`；没有要交付的页面时传空数组。一次动作完成后仍需继续任务时沿用原工作区。

macOS 桌面版把任务页面放进 Chromium 原生标签组。新建工作区仍共享应用专用 profile 内同站点的登录态，判断当前账号时请以页面实际显示为准。仅操作任务返回的页面句柄。登录流程打开新窗口时，从工作区页面清单按 openerPageId 和 openedByOperationId 找到对应子页。脚本工作线程受受管页策略约束。

省略 `agentName` 时可通过 `OPEN_BROWSER_AGENT_NAME` 配置默认名称。MCP 优先读取握手中的客户端标题，再读取名称。CLI 和 SDK 在已知 Codex 会话环境下显示 Codex，其他情况下分别显示 CLI 和 SDK。显示名称用于识别工作区创建者，访问权限由本机服务验证。

在项目根目录创建试用工作区可运行以下命令。

```sh
ob="$PWD/skills/open-browser/scripts/open-browser"
printf '%s\n' '{"name":"CLI 试用","agentName":"页面核验助手"}' | "$ob" createWorkspace
```

需要同时使用两个账号时，先给服务和调用端设置相同的 `OPEN_BROWSER_PROFILE`。每个 profile 使用自己的 Chromium 登录资料、本机服务和回执；同一 profile 的工作区仍共享站点账号。已配对的客户端通过 `OPEN_BROWSER_CLIENT_TOKEN_FILE` 选择自己的令牌。管理者可从本机 CLI 签发、委托和撤销权限，详见仓库 README。

- `act` 支持 `select` 和 `wait`。选择项使用最近观察中 combobox 的 ref 和选项 value。等待条件任选可见文本 `text`、完整页面地址 `url` 或可见元素 `element:{role,name}`，动作等待的 `timeoutMs` 为 1 到 10000。动作请求还可传顶层 `timeoutMs`，它是覆盖排队和执行的 1 到 60000 毫秒 wall budget。提交后等结果页的条件可与点击放在一批。用操作回执和网站结果共同核对业务完成。
- 控件可返回 `checked`、`pressed`、`expanded`、`selected`。其中 `checked` 和 `pressed` 可为 `"mixed"`。用 `{"kind":"setChecked","ref":"…","checked":true}` 要求目标状态，成功后从观察或 `delta.changed` 读回。
- 精确寻找主页面按钮时，传 `observe.locator`，例如 `{"role":"button","name":"Save","within":{"role":"region","name":"Order B"}}`。仅 `match.status:"unique"` 返回可操作引用。重名时查看 `match.candidates` 的容器再缩小范围。存在模态对话框时，`foreground` 给出标题及边界，可操作列表只包含前景内容。
- 在同批点击后用 `{"kind":"wait","navigation":"commit","timeoutMs":3000}`，从回执 `navigation` 区分 `document_committed`、`same_document` 和超时的 `not_committed`。再用 `wait.element` 指定 `checked` 等期望状态，或用 `wait.absent:{role,name}` 等待可操作控件消失。已派发的提交发生超时时，先核对网站结果。
- `observeAfter:"full"` 返回当次操作后的观察，`"delta"` 返回变化的文字和控件。文档或基线更换时可收到全量观察；旧代次、历史回执或页面已变更时，请再次观察。`includeFrames:true` 用于读取已授权的可见一级 frame 文本。需要操作嵌入控件时，传 `frameControls:true`，使用返回的 `frames[].elements[].ref`。框架重新加载后重新观察。
- 交付调用 `finishWorkspace`，传 `workspaceId`、唯一 `operationId` 及 `keepPageIds` 数组。保留的页面脱离任务，未选中的受管页关闭。重试沿用同一操作 ID 和同一页集合；收到 `outcome_unknown` 时先核实页面。用户也可从工作区面板选择保留页。新打开的普通标签无需清理。
- `listOperations` 查询结束的工作区回执；`listEvents` 使用 `after`、`limit` 续读。事件序号从响应的 `nextCursor` 取得。默认保留 7 天。使用随机操作 ID，避免把账号、URL 或正文写入 ID。

画布、拖拽或触摸操作先运行 `capabilities`。具有页面像素权限时，调用 `captureVisual`，传页面句柄及可选的 `region:{x,y,width,height}` 或最新元素 `ref`。PNG 的左上角对应返回的 `clip.x,clip.y`，坐标均为视口 CSS 像素。返回的 `frameId` 有效 8 秒，可用一次。通过 `act` 传同一帧的文档和控制代次，以及 `{"kind":"spatial","frameId":"<帧 ID>","action":{"type":"click","x":50,"y":50}}`。可用类型包括 click、hover、tap、drag（toX/toY）、scroll（deltaX/deltaY）、key（keys）和 text（text）。表单控件及私有区域已遮盖，登录继续使用语义引用。遇到 `stale_visual_frame` 时重新截图；若操作回执为 `outcome_unknown`，先核对业务结果。像素权限由本机管理员通过 `admin.setPixelPermission` 授予到指定工作区、调用方及来源。

### 长页面、弹窗和下载

- `observe` 返回 `truncated:true` 和 `nextCursor` 时，把页面句柄与 `cursor:nextCursor` 一起传给下一次 `observe`。知道目标名称时可直接传 `name` 做子串匹配。也可以传 `region:{x,y,width,height}` 按页面视口 CSS 像素选区。每批控件数量可用 `limit` 指定，取值 1 到 180。收到 `stale_cursor` 时重新观察。
- 点击持续被遮罩挡住会以 `target_obscured` 结束。读取最新页面、等待遮罩消失后，用新的操作号点击。收到 `inspect_before_retry` 时，先查站点提交结果再决定下一步。
- 登录流程从一次受管点击打开获准的 HTTP(S) 地址后，读操作回执的 `openedPageIds`。延迟开窗时也可通过 `getWorkspace` 找到发起这次操作的子页，以其句柄继续登录。
- 下载发生后用 `listDownloads` 查询当前工作区，通过 `downloadId` 区分同名文件。`cancelDownload` 需要工作区控制权限。用户在工作区面板保留所需文件后再交付任务，查看文件时以面板显示的路径为准。
- 用户保留文件后，`listOutputs` 返回本地 manifest。Agent 可用 `readOutput` 按 `offset` 和 `limit`（最多 64 KiB）读取 base64 分块，使用 `nextOffset` 续读。输出默认只保留 24 小时，凭据和页面正文不会写入 manifest。

原生对话框出现时，读取 `getWorkspace.pendingDialogs`，按页面、操作号、来源及对话框类型核实用途。用 `respondDialog` 传工作区、页面、dialogId、controlGeneration、accept，prompt 可另传 text。每个对话框只回应一次。用户可以在工作区扩展接管并处理。Playwright 无法标识对话框的发起 frame，多来源的 frame 树按取消处理。

上传时，用户在工作区扩展选定页面、核对来源并选择文件。调用 `listUploads` 取得该工作区的 fileId，再发送 `act` 动作 `{"kind":"upload","ref":"最近观察中的文件选择按钮","fileId":"用户授权的 ID"}`。单文件至多 8 MiB，只在当前页面、文档、来源和控制代次有效，五分钟失效。发给站点后即消耗授权。结果待核实时应先检查站点。

点击前以 `eventCursor` 保存工作区 nextCursor，触发后调用 `waitForEvent`，传同一页面句柄、after、kind（popup / download / dialog）、可选 operationId 和 timeoutMs（1–10000）。也可先发起等待再点击。超时返回 event:null，可从原游标继续；收到事件后使用 nextCursor。resourceId 对应子页、下载或对话框 ID。异步下载只能可靠归到页面时，省略 operationId 过滤。只读委托可查看事件，响应对话框和上传仍需控制权。

- 中断后用 `getRecoverySummary` 传工作区 ID。对 `observe` 标记的页重新观察，`handle_unavailable` 表示旧句柄已失效。对 `verify_site` 先核对网站结果，`already_completed` 表示已记录完成。交付回执的 `keptPageIds` 记录已移交的标签，`deliveries` 列出已确认保留的下载 ID，`outputs` 列出可续读的本地输出 ID。回执与资料分页分别使用 `nextCursor → after` 和 `nextObjectCursor → objectsAfter`。

- 创建工作区可传 `profileId`，服务核对它与已连接账号资料一致，返回并在接管面板显示资料名。多个账号分别启动对应的 `OPEN_BROWSER_PROFILE` 实例。CLI、MCP 通过同名环境配置连接，SDK 可用 `new OpenBrowserClient({profileId:'work'})` 选择本机已启动的命名实例。

### 按网站运行流程

将 [登录后导出](workflows/login-export.json) 或 [上传后核对](workflows/upload-verify.json) 保存为本地模板，按实际站点填写精确的 `origin`、控件角色、名称和成功条件。调用 `runWorkflow` 时传页面句柄、最新 `documentId`、`controlGeneration`、唯一 `operationId`、模板对象 `workflow`，以及本次运行的 `bindings`。例如 `{"attachment":"已授权 fileId"}` 或 `{"password":"已绑定 credentialRef"}`。模板仅保存参数名，每次运行时提供授权引用。服务端逐步重新观察、核对来源和控制权。

用 `getOperation` 查看已完成步数。遇到 `target_ambiguous`、`target_missing` 或 `workflow_origin_changed` 时核对页面和已执行步骤。登录后导出还应读取当前工作区的下载回执，核对交付物。

- 使用 `capabilities` 确认服务提供的方法和限额，`--schema` 输出当前 CLI 的全部方法和参数。遇到不支持的方法时以服务端返回的能力为准。
- `diagnoseOperation` 接受 `workspaceId` 和 `operationId`，返回已完成步数、是否记录过派发、故障类别和建议处置。桌面工作区面板也可预览并保存同一份脱敏 JSON。结果为 `check_site_result` 时先用页面的业务结果核实是否生效。

单页快捷入口

只需打开一个明确网址时，可直接调用 `open`，它会创建工作区并返回页面句柄。需要继续在同一任务中打开页面时，再按上面的 `createWorkspace` 和 `openPage` 流程操作。

当 `observe` 返回 `blockedRequests` 或 `getWorkspace` 返回 `blockedOrigins` 时，先核对来源和资源类型。用户或 Agent 取得当前工作区控制权后，可用 `grantOrigin` 传入最新 `controlGeneration`、完整 `origin` 和 `scope`。`resource` 只放行图片、字体、样式和媒体，`navigation` 才允许文档和脚本等完整站点能力。授权后重新 `observe` 或重新执行原操作。


### macOS

在 macOS 桌面版中，Skill 会优先连接应用内本机服务。需要打开浏览器窗口时运行 `npm start` 或打开 `/Applications/open-browser.app`。受管页面的人工接管按钮位于页面底部悬浮栏。
