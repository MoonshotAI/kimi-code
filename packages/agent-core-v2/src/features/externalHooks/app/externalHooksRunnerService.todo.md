# IExternalHooksRunnerService（externalHooksRunnerService）

- v2: `packages/agent-core-v2/src/features/externalHooks/app/externalHooksRunner.ts`（接口约 27 行；实现 `externalHooksRunnerService.ts` 约 133 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/externalHooks/runner.ts`（`ExternalHooksRunnerRef` facade）

## 能力对照

- [x] `trigger`/`triggerBlock`/`fireAndForgetTrigger`/`hasHooksFor` 四方法（matcher、inputData、signal、cwd、sessionId 传参；失败静默为空结果）→ `packages/harness-core/src/features/externalHooks/runner.ts`（同签名 `ExternalHooksRunner`）
- [x] hooks 按事件索引、summary 计数 → 同文件（`computed` 索引 + `summary` getter）
- [x] 配置区（hooks section）来源 hook 定义 → `packages/harness-core/src/features/externalHooks/feature.ts`（app slot 合并 config 与 sourced hooks）
- [x] hook 执行语义（matcher 匹配、阻塞判定、超时/cwd/env/shell）→ `packages/harness-core/src/features/externalHooks/internal/match.ts` 与 `internal/run.ts`
- [ ] 插件来源 hooks 合并与 `onDidReload` 重载 — v2 runner 合并 `IPluginService.enabledHooks()` 并在插件重载时重建索引；新栈虽有 `HookSources` 集合与 `useHookSource` 接缝（`hook-sources.ts`、`features/plugin/face.ts` 的 `useHookSource` prop），但没有任何宿主组合把 plugin feature 的 hook source 注入进来，插件 hooks 实际进不了 runner；重载由 computed 响应式取代但仅对已注入来源生效

备注：v2 的 `ready`/`onDidReload` 生命周期面在新栈由响应式 `computed` 与 `useReady` 取代，不计缺失。

## 结论

未对齐 1 项——插件来源 hooks 的接入与重载链路只留了接缝、宿主层未接线；runner 核心触发 API 与配置来源已全部对齐。
