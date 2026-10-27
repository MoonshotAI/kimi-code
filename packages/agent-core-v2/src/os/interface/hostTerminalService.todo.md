# IHostTerminalService（hostTerminalService）

- v2: `packages/agent-core-v2/src/os/interface/terminal.ts`（约 96 行，读 interface 与 schema 得出）
- 新架构: 无对应

## 能力对照

- [ ] PTY 终端派生（spawn：cwd/shell/cols/rows → TerminalProcess）— agent-core 与 harness-core 内无 PTY/终端域（已 Grep 核实，仅有的 terminal 字样均为 LLM 终止态语义），能力缺失
- [ ] 终端 IO 交互（onProcessData/onProcessExit/write/resize/kill）— 无对应
- [ ] 终端会话契约（terminalSchema / createTerminalRequestSchema / TerminalOutputMessage 等 attach 帧）— 无对应
- [ ] attach 回放（TerminalAttachSink / sinceSeq 断点续传）— 无对应

## 结论

未对齐 1 类：terminal 域决策不迁（终端能力属 kap-server 时代产品面，新栈两个包内无承载，亦无计划内替代）；pty 派生、IO 交互、契约与回放四项子能力随域整体缺席。
