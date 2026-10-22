# ICapabilityService（capabilityService）

- v2: `packages/agent-core-v2/src/app/capability/capability.ts`（约 21 行，读 interface 与 capabilityService.ts 得出）
- 新架构: `packages/harness-core/src/features/capabilities/feature.ts`（CapabilitiesRef facade）

## 能力对照

- [x] 内置能力条目 kimi-cu / kimi-webbridge 的检测（detect 分步、ready/partial/not_installed/unsupported 状态聚合）→ entries/kimiCu、entries/kimiWebbridge + statusOf（feature.ts；条目目录 `packages/harness-core/src/features/capabilities/entries/`）
- [x] listCapabilities()/getCapability(id) → CapabilitiesFace.list/get（feature.ts）
- [x] installCapability(id)：并发去重、不支持平台报错、进度步/百分比推进、失败落 error → CapabilitiesFace.install（feature.ts）
- [x] 安装进度变更通知（v2 onDidChangeInstall 事件）→ `capability.changed` 运行时事件（useFire，feature.ts；订阅侧用 kernel useOn / app.on）
- [x] 静态描述面（v2 describeCapabilities：id/pluginId/displayName/description/supported）→ list()/get() 返回的 CapabilityStatus 同名字段覆盖（状态检测一并进行，信息为超集）
- [x] 区域判定注入（resolveRegion：配置 oauthHost/key + KIMI_CODE_REGION_MARKER + homeDir）→ feature.ts resolveRegion（读 ProviderCatalogRef，亦可 props 覆盖）

## 结论

全部对齐——检测/安装/进度通知逐项由 capabilities feature 承载，事件机制由 Emitter 换成 kernel 运行时事件。
