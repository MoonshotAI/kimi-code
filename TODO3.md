# Agent 服务测试 / 迁移 TODO

这里记录 `packages/agent-core/test/services/agent` 里仍被跳过、仍依赖旧 `src/agent`、或仍缺少服务层等价覆盖的事项。它不是失败测试清单；当前全仓测试可以为绿，但这些条目表示后续迁移还没有收口。

恢复对应行为或测试时，应在同一个改动里移除匹配的 `it.skip` / `describe.skip`，或恢复被暂时关闭的 resume parity 断言。

## 判断口径

- **测试迁移债**：测试仍绑在旧 `src/agent` 类、旧 harness 假设、或旧 wire record 形状上。优先改测试到 `src/services/agent` 的服务接口；只有确认服务行为缺失后才下沉为功能缺失。
- **功能缺失**：服务层还没有实现旧 Agent 已有的一整块能力，或对应 builtin / runtime / restore 入口不存在。
- **行为待对齐**：服务层已有入口，但与旧实现或产品预期仍有语义差距，需要用测试锁住后修复。
- **协议升级不是缺陷**：当前服务层 canonical wire protocol 是 `AGENT_WIRE_PROTOCOL_VERSION = 1.5`。`context.splice` / `turn.launch` 是 v1.5 的设计结果；旧的 `context.append_message`、`context.append_loop_event`、`turn.prompt` 等应只作为 migration fixture 或历史日志输入出现。

## Wire 协议口径

- v1.5 migration 已经覆盖旧 record 到 `context.splice` / `turn.launch` 的转换，包括 prompt append 去重、tool call/result 投影、compaction summary、undo、forked goal 清理，以及中断 tool call 的合成 error result。
- 不要把“新日志不再写 `context.append_message` / `context.append_loop_event`”记录为 bug。当前测试若仍期望这些 record，应改成：
  - 直接断言当前 v1.5 `context.splice` / `turn.launch` 输出；或
  - 明确构造带旧 `protocol_version` 的迁移输入，测试 `migrateV1_*` / restore migration 行为。
- 如果 replay/range 测试只是在构造历史消息流，优先使用当前 v1.5 record；只有要覆盖历史兼容时才使用旧 record。

## 测试迁移债

- [x] 将剩余直接引用旧 `src/agent` 的测试迁移到服务层：
  - [x] `goal.test.ts`：已迁到 `IGoalService`、wire record、event bus / replay builder 覆盖旧 `GoalMode` 行为，不再直接引用旧 `src/agent`。
  - [x] `injection/plan-mode.test.ts`：已迁到 `IPlanModeService` + `IDynamicInjector`，覆盖 plan reminder 内容和 cadence，不再直接引用旧 `src/agent`。
  - [x] `injection/plugin-session-start.test.ts`：已迁到服务层 `AgentRuntimeOptions.pluginSessionStarts` + `IDynamicInjector`，覆盖 skill lookup、instruction rendering、warning、replay de-duplication，不再直接引用旧 `src/agent`。
  - [x] `background/output-access.test.ts`：已从旧 background helper 迁到 `IBackgroundService` + `ProcessBackgroundTask`，不再直接或经测试 helper 依赖旧 `src/agent`。
  - [x] `background/ids.test.ts`：已从旧 background helper 迁到 `IBackgroundService` + service-owned task classes，不再经测试 helper 依赖旧 `src/agent`。
- [x] 重写 `records/index.test.ts` 里的 skipped replay range 覆盖。fixture 已从旧 `context.append_message` / `context.clear` / `context.undo` 迁到 v1.5 `context.splice`，`describe.skip` 已解除，断言改为基于 splice 输出（其中 `does not rewrite migrated wire records while projecting` 本就是带旧 `protocol_version` 的 migration compat 用例，保持不变）。剩余 6 个测试仍红，根因已下沉为服务层 replay 缺口（见下方“行为待对齐”里的 replay range / splice 条目），不再是 fixture 迁移债。
- [ ] 清理 skipped 测试中的旧 wire snapshot。`context.test.ts` 当前 live/current 协议断言已清到 v1.5 `context.splice`，仅保留带旧 `protocol_version` 的 migration fixture；`permission.test.ts` 与 `plan.test.ts` 已审计，文件内没有旧 wire snapshot 或 skip。`resume.test.ts`、`turn.test.ts`、`compaction/full.test.ts`、`compaction/micro.test.ts` 里仍有旧 record 形状；解除 skip 前先判断是“迁移 fixture”还是“当前协议快照”。
- [x] 给 service runtime 的 `Skill` model-tool 语义补等价测试后，恢复 `skill-tool-manager.test.ts` 中 skipped 的 model-invocable skill 覆盖。已补 `ModelSkillTool` + `IAgentSkillService.activateFromModel()`，复用旧 `SkillTool` schema/description/rule matcher/prompt renderer，slash skill activation 仍走 `IAgentSkillService.activate()`。覆盖测试：`skill-tool-manager.test.ts`。

## 功能缺失

- [x] 增加服务原生 foreground task 语义：`detached: false`、等待 foreground release、注册时 abort signal、foreground task 不计入 detached/background task limit。覆盖测试：`background/foreground-persistence.test.ts`、`background/manager.test.ts`。
- [x] 定义并实现 foreground task detach 持久化状态迁移，包括 detach 前已完成输出 flush 到磁盘。覆盖测试：`background/foreground-persistence.test.ts`。
- [x] 将旧 manager 的 background notification delivery 行为迁移到服务层：`turn.steer`、context replay、`Notification` hook delivery、idle auto-turn launch、busy-turn buffering，以及 restore 后的 terminal notification injection。覆盖测试：`background/rpc-events.test.ts`、`bg-idle-notification-repro.test.ts`。
- [ ] 收口 Bash 相关剩余 parity：Bash runtime 注册、background gating、plan-mode Bash 普通 permission、approval/cancel/steer 交互，以及 Pre/PostToolUse 成功/失败 cadence 已由服务层测试覆盖；不再把 Bash builtin 本身列为未迁移。剩余重点是 PermissionRequest/PermissionResult observer hooks、PreToolUse 等待期间 cancel 不执行 Bash，以及与 Bash 场景相关的 Interrupt / UserPromptSubmit skipped hook parity。覆盖测试：`permission.test.ts`、`plan.test.ts`、`tool.test.ts`、`turn.test.ts`。
- [ ] 将仍缺服务层 model-tool 入口的旧 Agent-bound tools 迁完：`Agent`、media upload/read、goal tools。`AskUserQuestion` 已通过复用旧 `AskUserQuestionTool` 的结构化 host 迁到 service runtime，覆盖 foreground question、dismiss、unsupported 分支，并保留旧工具构造路径。注意：`AgentSwarm` 已由 `SwarmModeService` 注册，model-invoked `Skill` 已由 `ModelSkillTool` 注册，`TodoList` / `Cron*` / `EnterPlanMode` / `ExitPlanMode` 也已经是 service-owned tools，不应再列入“未注册 builtin”。覆盖测试：`question.test.ts`、`tool.test.ts`、`permission.test.ts`、`skill-tool-manager.test.ts`。
- [x] 将 plugin session-start injection 完整迁移到服务层 dynamic-injection runtime，包括 skill lookup、instruction rendering、warning behavior，以及 replay de-duplication。覆盖测试：`injection/plugin-session-start.test.ts`。
- [ ] 做一次 full-compaction 服务行为对齐：manual/auto lifecycle、micro-compaction access、OAuth retry、hooks、provider-overflow retry accounting、todo-store integration、history-change cancellation，以及 resume parity。覆盖测试：`compaction/full.test.ts`。
- [ ] 做一次 micro-compaction 服务行为对齐：cutoff/projection/telemetry 语义、cache-miss detection、restore、undo，以及与 full-compaction 的交互。覆盖测试：`compaction/micro.test.ts`。

## 行为待对齐

- [ ] 恢复 skipped 的 resume projection 覆盖：tool-store 状态恢复已补；goal completion replay card 已补；从历史记录重建 turn counter 已补；pending tool results restore/projection 已补。剩余重点是 compaction replay cards、延迟 reminders，以及中断 tool call 的合成结果。这里应按 v1.5 canonical records 断言；旧 records 只用于 migration 输入。覆盖测试：`resume.test.ts`、`context.test.ts`、`records/index.test.ts`。
- [x] 修复 replay range 无法下传到 runtime 的缺口：已恢复接线。新增 `AgentRuntimeOptions.replay.range`，harness `TestAgentOptions.replay` 透传，并在 `configureAgentRuntimeServices()` 里用 `new SyncDescriptor(ReplayBuilderService, [{ range }], true)` 覆盖全局写死的 `[{}]`，把 range 注入 `ReplayBuilderService`；同时恢复 `buildReplayFromPersistence` helper 里被删的 `testAgent({ replay: { range } })`。`buildResult()` 基于 replay records 的 start/count 切片重新生效。覆盖测试：`records/index.test.ts`。
- [x] 让 `context.splice` 的删除反映到 replay：已修。在 `ContextMemoryService.applySplice` 里 `history.splice(...)` 之前先切出被删消息，部分删除（旧 `context.undo` 语义）时调用 `replayBuilder.removeLastMessages(new Set(removedMessages))`，与插入的 `replayBuilder.push` 对称；整段清空（旧 `context.clear`）不调删除，保留 boundary 语义。覆盖测试：`records/index.test.ts`（`keeps the start offset correct when undo removes more messages than count`）。
- [x] 让 `context.splice` 成为 undo boundary：已修。删掉 `UNDO_BOUNDARY_RECORD_TYPES` 集合，改为内容感知谓词 `isUndoBoundaryRecord(record)` = `record.type === 'context.splice' && record.start === 0 && record.deleteCount > 0`（对齐旧 clear/compaction “从头删” 语义，避免把 mid-history undo / append 误判成边界）；`finishRestoringRecord` 改为接收整条 `WireRecord`。判断为“替换”而非“增补”：restore 流程先 `applyWireMigrations()` 再 fire hook，replay builder 永远只看到迁移后的 record，旧的 `context.clear` / `context.apply_compaction` 不会到达。覆盖测试：`records/index.test.ts`（`clamps results at undo boundaries`）。compaction replay 投影缺口仍由上方 full-compaction 对齐项收口（`continues reading after count so later wire records can patch captured replay records` 当前仍红，属该项）。
- [x] 恢复 session 级 approval replay 到 `PermissionRulesService.sessionApprovalRulePatterns`，不能只恢复一次性的 approval notification。已修复：`PermissionRulesService` 的 `permission.record_approval_result` handler 在构造函数里注册，但 DI 中是懒代理，`AgentRuntime.restore()` 的预热块未触发其构造，回放时 handler 不存在、session rule 无法恢复。已在该预热块补 `accessor.get(IPermissionRulesService).rules` 强制构造。`permission.test.ts` 全绿（178），`it('replays session approval wire events into agent permission state')` 已解除 skip，one-shot 对比测试行为不变。
- [ ] 排查 `activateAgentServices()` 懒代理“假预热”：审计已完成，裸 `accessor.get(...)` 对 delayed service 不能作为完整预热屏障。已补 `IPermissionRulesService.rules` 强制构造以恢复 session approval replay；已补 `ISwarmMode.isActive` 强制构造以恢复 `AgentSwarm` service-owned tool 注册；已补 `IProfileService.data()`、`IPermissionModeService.mode`、`IPermissionService.data()` 以激活 config / permission restore handlers 和初始 permission mode；已补 `IBackgroundService.list` 强制构造以恢复 background restore/reconcile hooks；已补 `IAgentSkillService.activate` 强制构造以恢复 `skill.activate` replay handler，覆盖 `skill-tool-manager.test.ts`。restore 预热已补 `IToolStoreService.data()`、`IUserToolService.register` 和 `IGoalService.getGoal()`。后续优先核对/修复构造期有 wire handler、hook、tool、event listener 的高风险服务：`IPlanModeService`、`IMcpRuntimeService`、`IFullCompaction`、`IMicroCompactionService`、`IContextUsageService`、`ILoopService`。覆盖测试按对应服务单文件收口，不做一次性大改。
- [x] 恢复 registered user-tool 的 full resume parity：restore 前强制构造 `IUserToolService`，恢复 active registered tools，并重新打开 `basic.test.ts`、`config.test.ts`、`tool.test.ts` 中对应的 `expectResumeMatches()`。覆盖测试：`basic.test.ts`、`config.test.ts`、`tool.test.ts`。
- [x] 完成 `PlanModeService` 行为对齐：`plan.test.ts` 已全部恢复并通过（19/19），覆盖 path derivation、filesystem calls、clear/read/exit flow、approval rejection handling、plan reminders、injection cadence、read-only Bash/yolo、普通 Bash/yolo，以及已覆盖用例的 resume parity。`injection/plan-mode.test.ts` 已从旧 `src/agent` 迁到 `IPlanModeService` + `IDynamicInjector` 并通过（9/9）。Bash 的 manual/approval/cancel 交互继续由 Bash 项收口。覆盖测试：`plan.test.ts`、`injection/plan-mode.test.ts`。
- [ ] 恢复服务层 goal replay 语义：已恢复 `goal.*` records、`forked` boundary 清空 copied goal、fork-cleared reminder、goal completion replay card，以及 goal injector boundary cadence。剩余重点是 goal-cleared reminders 的更广泛交互，以及 goal-outcome cleanup。覆盖测试：`goal.test.ts`、`injection/goal.test.ts`、`records/index.test.ts`、`resume.test.ts`。
- [ ] 恢复 turn-flow hook / event parity：`PreToolUse` / `PostToolUse` 成功路径已补，same-step dedup 的 `PostToolUse` 真实输出也已恢复，`PostToolUseFailure` 与 `StopFailure` 已补。剩余重点是 `Interrupt`、provider finish-reason details、model-not-configured diagnostics、LLM request logging，以及 duplicate tool-call telemetry。覆盖测试：`tool.test.ts`、`turn.test.ts`。
- [x] 完成 swarm-mode replay restore parity：manual/task/tool 进入和退出的运行时行为已恢复；task turn 正常完成、失败、取消时 auto-exit 已对齐旧 `src/agent`，`AgentSwarm` silent/tool 模式也已恢复；restore `swarm_mode.exit` 会清理已重放的 enter reminder 且不制造新的 exit reminder。覆盖测试：`tool.test.ts`、`turn.test.ts`。
