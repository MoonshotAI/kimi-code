# IWireService（wireService）

- v2: `packages/agent-core-v2/src/wire/wire.ts`（约 32 行，读 interface 与 wireService.ts 实现要点得出）
- 新架构: `packages/agent-core/src/store/writer.ts` + `packages/agent-core/src/session/session.ts`（结构取代）

## 能力对照

- [x] 会话日志追加与读取（appendRecord/readJournal，含 dehydrate blob 卸载）→ `packages/agent-core/src/store/writer.ts` 的 Log.commit + `packages/agent-core/src/session/session.ts` 的 per-agent 日志（toLoopRecord 批量提交）；大对象卸载由 `packages/agent-core/src/llm/builtin/policy/store-ref/` 与 blob 域承载
- [x] 恢复链读取（readRestorable/readRestoreChains → resume 水合）→ session.ts 的 loopProjection 视图水合（profile/messages/nextTurnId/unfinished turn）
- [x] 人类可见链（readHumanChain）→ agent 的 view.getState().messages（loopProjection 折叠产出）
- [x] 封存/冲刷/持久化排空（seal/flush/drainPersisted）→ agent flush（微批提交）与 writer.close；session close 生命周期单向流转
- [x] 客户端传输面（wire 记录经 kap-server REST/WS 外发）→ `packages/harness-core/src/feature-http/`（server.ts/ws.ts 与 route-*）+ `packages/harness-core/src/feature-acp/`，结构取代
- [ ] 命名多分支树与切换（IAgentJournal.switchBranch/branches：undo 保留旧分支可切回）— 新栈 undo 为 rewind 截断、fork 复制新日志，无命名分支切回，结构取代中丢弃
- [ ] 外部修改检测（externallyModified）— 无对应机制（仅 writer.lock 防并发），未迁
- [ ] 物理日志路径暴露（journalPath）— 引擎不暴露物理路径，未迁
- [ ] context-clear 行标记（lastContextClearLine）— 无对应；新栈上下文压缩由 compaction feature 以不同机制承担

## 结论

未对齐 4 项：日志持久化/恢复/人类链/传输面已由 agent-core store+session 与 feature-http/feature-acp 结构承载；命名分支切回、外部修改检测、journalPath、lastContextClearLine 未迁（分支树被 rewind/fork 决策性取代）。
