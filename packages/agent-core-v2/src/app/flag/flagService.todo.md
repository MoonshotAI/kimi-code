# IFlagService（flagService）

- v2: `packages/agent-core-v2/src/app/flag/flag.ts`（约 64 行 interface）
- 新架构: 无统一对应（各 feature 分布式 env flag）

## 能力对照

- [ ] enabled(id) 统一开关判定（四级优先级：per-flag env > `[experimental]` 配置 > master env > 注册默认值）— 降级：新栈无统一 flag 服务，各 feature 内联 `envFlagEnabled` 自查 `KIMI_CODE_EXPERIMENTAL_<NAME>` 或 master env `KIMI_CODE_EXPERIMENTAL_FLAG`（如 `packages/harness-core/src/features/notify/feature.ts`、`packages/harness-core/src/features/tower/feature.ts`、`packages/harness-core/src/features/swarm/feature.ts`），只剩两级、无配置层与集中默认值
- [ ] `[experimental]` config section 与 setConfigOverrides（配置层覆盖开关）— 未迁：`packages/harness-core/src/features/config/` 无 experimental section
- [ ] snapshot()/enabledIds()/explain()/explainAll()/exposedIds() 开关观测面 — 未迁：v2 经 kap-server meta 路由暴露 experimental_flags（`packages/kap-server/src/routes/registerApiV1Routes.ts` 约 104 行），新栈 `packages/harness-core/src/feature-http/route-builtin/meta.ts` 无该字段；TUI experiments 页已删

## 结论

未对齐 3 项——统一实验开关服务决策性不迁，各 feature 分布式 env flag 仅保留两级判定，观测面与配置层缺失。
