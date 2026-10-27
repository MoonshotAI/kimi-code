# IFeatureManager（featureManager）

- v2: `packages/agent-core-v2/src/app/feature/featureManager.ts`（约 36 行，读 interface 与 featureManagerService.ts 得出）
- 新架构: `packages/harness-core/src/app/features.ts`（createFeature/Features/FeatureSet）+ `packages/harness-core/src/app/app.ts`（app.features）+ `packages/harness-core/src/app/units.ts`（useMirror 挂载）

## 能力对照

- [x] provideUnit(recipe/id, opts)（运行时动态挂载 feature unit，返回句柄）→ app.features.add(feature, { scope, props })（app.ts；经 featureSetOf 支持 app/session/agent 三级作用域，units.ts 的 useMirror/useLevel 实际挂载）
- [x] unprovideUnit(name)（卸载并等待清理）→ app.features.delete(feature|name, scope)，删除后等待 root.ready() 落停（app.ts）
- [x] updateUnit(name, config)（更新 unit 配置）→ features.add 同名条目替换 props 后，useMirror 对同 recipe 走 `child.update(props)` 热更新（units.ts）
- [x] units() 变化通知（v2 onDidChangeUnits）→ FeatureSet 基于 shallowReactive Map，watch 驱动挂载树重建（features.ts/units.ts）
- [x] 静态 feature 组合（v2 featureAssemblyService 装配）→ `packages/harness-core/src/preset.ts`（harnessPreset）+ createHostFeature（units.ts）
- [ ] units() 运行时自省清单（name/state/uid/meta；v2 供 kap-server /api/v1/debug 与 kimi-inspect 的 DI unit 检视）— 新栈 App 仅有 features.list 返回 feature 定义，无 unit 状态/uid 级清单暴露，归属 kap-server 调试面未迁
- [ ] contributedServices() 贡献服务清单（FeatureServiceContribution collection 的对外列举）— kernel 的 useContribute/useCollection 机制存在（`packages/harness-core/src/composition-api/hooks.ts`），但无等价的「贡献服务目录」对外门面，未迁

## 结论

未对齐 2 项——动态挂载/卸载/热更新/作用域主能力已由 app.features + useMirror 承载；unit 运行时自省与贡献服务清单两个调试向门面未见等价。
