'use strict';

globalThis.openBrowserPhaseLabels = Object.freeze({
  idle: '等待指令', queued: '已排队', running: '执行中', actionability: '检查目标',
  dispatching: '正在派发', waiting: '等待页面', verifying: '核对结果',
  needs_credential: '等待凭据', completed: '已完成', failed: '失败',
  cancelled: '已取消', outcome_unknown: '结果待核实',
});
globalThis.openBrowserModeLabels = Object.freeze({ agent: 'Agent 控制', human: '人工接管', transferring: '交接中' });
