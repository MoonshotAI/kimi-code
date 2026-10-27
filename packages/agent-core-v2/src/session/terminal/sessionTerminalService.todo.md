# ISessionTerminalService（sessionTerminalService）

- v2: `packages/agent-core-v2/src/session/terminal/terminalService.ts`（约 265 行，interface 与实现同文件）
- 新架构: 无对应

## 能力对照

- [ ] PTY 会话管理（create/list/get/close，经 runtime 租约 spawn 终端进程）— 决策不做：agent 工具层不使用该服务，消费方仅 kap REST 终端面；新栈两个包内无 PTY 管理（os feature 只有 process-exec，无终端端口）
- [ ] 输出帧缓冲与 attach/detach 多订阅回放（ring buffer + sinceSeq replay）— 决策不做：随 PTY 面一并放弃
- [ ] 写入/缩放（write/resize）与退出状态上报 — 决策不做：同上
- [ ] runtime 租约集成（按 workspaceId/runtimeId acquire 租约并跟踪进程销毁）— 决策不做：v2 的 IRuntimeResolver/RuntimeLease 体系随旧栈退役，新栈无 runtime 租约概念

## 结论

未对齐 4 项——PTY 终端管理整体决策不做（agent 工具层不用，消费方仅 kap REST）。
