# IFlagRegistry（flagRegistry）

- v2: `packages/agent-core-v2/src/app/flag/flagRegistry.ts`（约 39 行 interface）
- 新架构: 无对应

## 能力对照

- [ ] register/get/list 统一开关注册表（`registerFlagDefinition` 导入期贡献 + 运行期注册）— 决策性不迁：新栈无 flag 注册表，开关声明分散在各 feature 源码常量中（如 `packages/harness-core/src/features/notify/feature.ts` 的 NOTIFY_USER_FLAG_ENV、`packages/harness-core/src/features/tower/ops.ts` 的 TOWER_FLAG_ENV）
- [ ] surface（core/tui/both）与 isExposed 曝光元数据 — 未迁：该元数据服务于已删除的 TUI experiments 页，新栈无消费方

## 结论

未对齐——注册表机制整体决策性不迁，开关定义随各 feature 私有化。
