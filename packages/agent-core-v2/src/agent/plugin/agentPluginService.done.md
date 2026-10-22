# IAgentPluginService（agentPluginService）

- v2: `packages/agent-core-v2/src/agent/plugin/agentPlugin.ts`（约 10 行，读 interface 与 agentPluginService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/plugin/agent/session-start.ts` + `packages/harness-core/src/features/plugin/agent/change.ts`

## 能力对照

- [x] refreshSessionStart：标记待刷新并在空闲时重 reconcile sessionStart 提醒 → `packages/harness-core/src/features/plugin/agent/session-start.ts`（refreshPending + useStepStarting 驱动 reconcile）
- [x] 插件 sessionStart 提醒渲染（plugin_session_start 块、SUPERSEDES_SUFFIX、无 active 时的中性化文案、compaction 后中性化）→ `packages/harness-core/src/features/plugin/agent/session-start.ts`（renderSessionStartBlock / NO_ACTIVE_SESSION_STARTS / shouldNeutralizePluginSessionStart 逐字对应）
- [x] sessionStart 内容 durable 快照（PluginSessionStartEvent）→ `packages/harness-core/src/features/plugin/agent/session-start.ts`（pluginSessionStartProjection + PLUGIN_SESSION_START_SNAPSHOT）
- [x] 插件 install/enable/disable/remove/mcp-server 变更提醒（plugin_change）→ `packages/harness-core/src/features/plugin/agent/change.ts`（renderPluginChangeReminder，经 session-start.ts watch lastMutation 触发）
- [x] 缺失 sessionStart skill 的告警去重 → `packages/harness-core/src/features/plugin/agent/session-start.ts`（warnedMissingSkills）

## 结论

全部对齐（sessionStart 提醒 reconcile、变更提醒、快照与告警均在 plugin feature 的 agent 层承载）。
