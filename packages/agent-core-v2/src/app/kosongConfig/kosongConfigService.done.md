# IKosongConfigService（kosongConfigService）

- v2: `packages/agent-core-v2/src/app/kosongConfig/kosongConfig.ts`（约 10 行 interface；实现 kosongConfigService.ts 约 179 行——config↔provider/model 双向同步桥，一并读过）
- 新架构: `packages/harness-core/src/features/provider-catalog/feature.ts`

## 能力对照

- [x] 启动物化（把 providers/models/default_provider/default_model 配置加载为可用目录）→ feature.ts 的 reconcile（watch 各 section 后向 catalog upsert）
- [x] 配置变更反向同步运行态 → reconcile 经 coalescedMicrotaskScheduler 合并重调和
- [x] 运行态默认模型回写配置 → feature.ts 的 ModelDefaultsRef.setDefaultModel / SessionModelRef.setModel 写 DEFAULT_MODEL_CONFIG_SECTION；provider 改名时回写 DEFAULT_PROVIDER_CONFIG_SECTION（`packages/harness-core/src/feature-http/route-builtin/model-catalog.ts` 约 354 行）
- [x] ready 初始化屏障 → createProviderCatalog().then 置 ready ref，reconcile 等待 ready
- [x] 持久化失败重试（v2 的 retry 链）→ 结构性替代：config feature 的统一写入语义（`packages/harness-core/src/features/config/store.ts`）

## 结论

全部对齐——config↔目录双向同步由 provider-catalog reconcile 与各 Ref 回写承载，结构由「专用桥」变为「响应式重调和」。
