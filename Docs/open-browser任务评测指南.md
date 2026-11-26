# open-browser 任务评测指南

这份指南定义 open-browser 的本地验收口径。评测只使用本机测试站、合成账号和项目专用 Chromium，结果只描述当前源码和测试环境。

## 快速回归

```sh
npm run test:unit
npm run test:contract
npm run build:verify
```

单项边界测试可以直接运行。

```sh
node --test observation-boundaries.test.mjs lifecycle.test.mjs managed-popup.test.mjs downloads.test.mjs
node --test visual-page.test.mjs service.integration.test.mjs
```

## 评测维度

| 维度 | 需要核对的结果 |
| --- | --- |
| 页面观察 | 可见文本、角色、名称、控件顺序和敏感字段脱敏 |
| 页面动作 | 点击、填写、选择、拖拽、等待和导航状态正确，旧引用返回稳定错误 |
| 并发 | 多工作区可以并行，同页动作保持顺序，队列和内存上限生效 |
| 接管 | 用户接管后 Agent 读写被拒绝，交回后重新观察并继续同一页面 |
| 登录 | 凭据按工作区和来源隔离，缺少凭据时可在可信入口补充 |
| 下载 | 下载归属工作区和页面，取消、保留、交付、分块读取和清理正确 |
| 恢复 | 断线、服务重启和结果未知时不自动重复提交，可按回执继续判断 |
| 隐私 | 未授权来源、子资源、WebSocket、截图和客户端读取均被正确限制 |
| 桌面 | 新标签页控制台、标签分组、接管栏和结束任务流程可用 |

## 本地夹具

测试服务只监听回环地址，并在每轮测试结束后清理临时资料。需要自定义页面时，可复用 `studio/demo-site.mjs` 的登录夹具，避免使用真实账号、Cookie、令牌或业务数据。

```sh
node benchmarks/task-eval.mjs 3
node benchmarks/semantic-controls.mjs 3
node benchmarks/workflow-journeys.mjs 3
node benchmarks/privacy-audit.mjs
```

评测脚本输出 JSONL 到标准输出，不会写入仓库。需要保存结果时，请使用项目外的临时目录，并在提交前删除其中可能包含的页面文本、URL 或诊断数据。

## 记录格式

需要记录源码提交、Node 版本、Chromium 版本、操作系统、并发数、样本数、P50/P95、峰值 RSS、错误码和站点最终状态。性能数字只适用于记录的机器、夹具和入口。模型完成率需要另行固定模型、提示词、工具预算和评分器。

## 隐私复核

```sh
node cli.mjs capabilities
node benchmarks/privacy-audit.mjs
node --test privacy-config.test.mjs observation-boundaries.test.mjs
```

隐私审计使用临时资料和回环站点。原始 NetLog 可能包含测试 URL，测试结束后应删除。公开报告中不要包含真实账号、Cookie、令牌、截图或页面正文。
