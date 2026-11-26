# open-browser 托管工作节点

一个协调进程管理会话、节点选择、写租约和提交回执。工作节点通过现有 open-browser 服务启动专用无头 Chromium，每个工作区获得独立的 BrowserContext。桌面版与个人资料目录另行运行。本目录是可独立启动的 Unix 托管入口。

## 在一台机器上启动两个节点

在仓库根目录使用支持 `node:sqlite` 的 Node.js（本机验证版本 26.4），先安装项目依赖及项目专用 Chromium。以下命令初始化一个新目录。初始化器拒绝覆盖已有配置。

```sh
npm ci
npm run browser:install
export OPEN_BROWSER_HOSTED_DIR="$HOME/.open-browser/hosted"
node hosted/init.mjs "$OPEN_BROWSER_HOSTED_DIR"
OPEN_BROWSER_PROFILE=default OPEN_BROWSER_STATE_DIR="$OPEN_BROWSER_HOSTED_DIR/node-a" node service.mjs --headless &
worker_a=$!
OPEN_BROWSER_PROFILE=default OPEN_BROWSER_STATE_DIR="$OPEN_BROWSER_HOSTED_DIR/node-b" node service.mjs --headless &
worker_b=$!
node hosted/server.mjs "$OPEN_BROWSER_HOSTED_DIR" &
coordinator=$!
```

默认配置为两个租户各分配一个节点。如果一个租户允许使用多个节点，在相应节点的 `tenants` 数组加入该租户 ID，再重启协调器。创建会话时选择可用节点中会话数最少者，节点编号用于打破平局。已创建的会话固定在所选节点。

每个节点都使用专用 service 模式。协调器的输入是 `config.json` 中的 Unix socket 和节点令牌文件，示例使用同机的两个独立服务进程。多主机部署需要为每个节点提供经过认证的私有通道，并安全同步节点每次启动时轮换的令牌。此次验收覆盖同机双进程。单个 SQLite 协调目录支持一个活动协调器，数据库文件应置于本机文件系统。

## 使用租户 CLI

租户身份取自 Bearer 凭证。管理令牌、工作节点令牌和其他租户的令牌只由服务操作方保管。本机示例由同一操作系统用户运行，租户隔离在 API 层验证。生产客户端需要独立的系统账号或容器和经过访问控制的接入通道，以免客户端直接读取服务端目录中的密钥。

```sh
export OPEN_BROWSER_HOSTED_TOKEN_FILE="$OPEN_BROWSER_HOSTED_DIR/tenant-a.token"
node hosted/cli.mjs nodes
printf '%s\n' '{"sessionId":"demo","allowedOrigins":["https://example.org"]}' | node hosted/cli.mjs create
printf '%s\n' '{"sessionId":"demo"}' | node hosted/cli.mjs acquire
```

最后一个命令返回 `lease` 和毫秒时间戳 `expires`。将其返回的令牌代入以下输入。所有节点健康及操作回执都可用相同形式从 SDK 读取，协议为 HTTP POST 到 Unix socket 的 `/v1/call`，正文使用 `{"method":"…","params":{…}}`。CLI 采用同一 SDK 传输函数。

| 方法 | JSON 输入示例或说明 |
| --- | --- |
| `nodes`、`sessions` | `{}`，列出本租户获准节点或会话 |
| `status`、`acquire` | `{"sessionId":"demo"}` |
| `renew`、`release` | `{"sessionId":"demo","lease":"…"}` |
| `openPage` | `{"sessionId":"demo","lease":"…","operationId":"p1","params":{"url":"https://example.org/"}}` |
| `observe` | `{"sessionId":"demo","lease":"…","pageId":"打开页回执中的 pageId"}`，可传 `name`、`limit`、`region`、`includeFrames` 或 `frameControls`。续读时仅附上 `cursor`。 |
| `act` | `{"sessionId":"demo","lease":"…","operationId":"a1","params":{"pageId":"…","documentId":"…","controlGeneration":"…","actions":[{"kind":"click","ref":"观察返回的 ref"}]}}` |
| `receipt` | `{"sessionId":"demo","operationId":"a1"}`，允许原持有者断线后按会话和操作 ID 核实 |
| `closeWorkspace` | `{"sessionId":"demo","lease":"…","operationId":"end"}` |
| `finishWorkspace` | `{"sessionId":"demo","lease":"…","operationId":"end","params":{"keepPageIds":[]}}`，交付已完成任务并关闭无头工作区 |

每个会话同时授予一份 30 秒写租约。观察会生成新的页面元素引用，因此也携带当前租约。持有者可续租，有未完成的写操作时继续查询回执，再释放或申请租约。操作号可在同一会话重用以查询同一请求。不同动作使用新的操作号。协调器重启后应重新申请租约。

协调器 SQLite 记录租户编号、会话和页面编号、节点、状态、操作类型、带密钥的请求摘要及核实决定。请在编号中使用随机或业务无关的值。页面正文经显式 `observe` 返回给已认证租户，协调器不将观察正文、动作参数、站点 Cookie 或截图写入该库。登录态留在节点的浏览器上下文，节点重启后需重新登录。工作节点另外保存原有的本地回执。

## 失联与人工核实

协调器每 750 毫秒并发探测各节点的授权能力接口，单次探测期限为 2 秒。失联或节点实例更换会使原会话进入 `review` 并撤销租约。已派发的操作固定在原节点，协调器不会在恢复时自动重发。协调器启动时，创建中或仍有操作待决的会话也会进入核实流程。

1. 恢复原节点的服务及状态目录，以便读取其本地回执。
2. 管理员从同一 CLI 调用 `review`，对照站点自身的订单、表单或其他结果。节点回执表示浏览器的执行进展，站点记录决定业务提交结果。
3. 以 `applied`、`not_applied` 或 `unknown` 记录人工判定。协调器先回收仍存活的工作区，再归档会话。若建工作区期间失联而不知道其标识，需要重启原节点以回收孤立上下文。后续任务使用新的会话编号。

```sh
export OPEN_BROWSER_HOSTED_TOKEN_FILE="$OPEN_BROWSER_HOSTED_DIR/admin.token"
printf '%s\n' '{"tenant":"tenant-a","sessionId":"demo"}' | node hosted/cli.mjs review
# 核对站点确认已经提交后执行
printf '%s\n' '{"tenant":"tenant-a","sessionId":"demo","decision":"applied"}' | node hosted/cli.mjs review
```

关闭手动启动的实例可执行 `kill "$coordinator" "$worker_a" "$worker_b"`。下次启动复用现有目录并从启动节点的命令开始。

## 真实故障演练

从仓库根目录执行 `node --test hosted/hosted.test.mjs`。测试在独立临时目录启动两个 Chromium 工作节点、协调器和自有 HTTP 站点。两个账号通过一次性登录票据获得 HttpOnly 会话。站点记录一次提交并延迟 HTTP 响应，测试随即强杀对应节点。另一个节点继续以自己的身份浏览。重启原节点后，管理员读取节点回执，对照站点提交次数并归档。测试还检查租约互斥、旧租约失效、跨租户回执隔离、协调器重启及本地元数据中无明文登录票据。结束后清理自建实例。
