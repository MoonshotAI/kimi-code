# IFeatureAssemblyService（featureAssemblyService）

- v2: `packages/agent-core-v2/src/features/featureAssembly.ts`（接口约 8 行 brand-only；实现 `featureAssemblyService.ts` 约 26 行 + `featureRegistry.ts` 约 15 行，能力读实现得出）
- 新架构: `packages/harness-core/src/app/features.ts`（`createFeature`/`Features`）+ `packages/harness-core/src/preset.ts`（`harnessPreset` 注册表）

## 能力对照

- [x] 集中装配：把注册表中全部 feature recipe 在 App scope 创建时一次性提供给 feature 管理器（v2 `registerFeature` 全局注册表 + `ScopeActivation.OnScopeCreated`）→ `packages/harness-core/src/preset.ts`（`harnessPreset` 静态数组）与 `packages/harness-core/src/app/features.ts`（`Features.add/delete/list`）
- [x] feature 按层级（App/Session/Agent）展开挂载 → `packages/harness-core/src/app/features.ts`（`createFeature(name, units)`，`FEATURE_LEVELS = app/session/agent` 三级 unit recipe）
- [x] feature 间依赖解析不在装配层排序（v2 靠 DI 构造注入与 OnDemand 激活；assembly 只做全量注册，无显式排序/依赖图）→ 新栈同样无排序语义，依赖经 kernel `useInject`/facade token 在 unit setup 内解析，装配顺序即 preset/注册顺序
- [x] 作用域化增删（按 session/agent 范围挂载 feature）→ `packages/harness-core/src/app/features.ts`（`FeatureScope` 与 `featureSetOf`）

备注：v2 的「任意模块 import 时 side-effect 自注册」被显式的 preset/宿主组合取代，属结构变化；对用户可见能力（各 feature 在产品中生效）无影响。

## 结论

全部对齐：装配语义由 DI 注册表 + scope 激活改为 createFeature + preset 静态组合的结构取代，能力面无缺失。
