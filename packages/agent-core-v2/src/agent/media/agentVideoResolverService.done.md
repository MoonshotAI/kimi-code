# IAgentMediaResolverService（agentVideoResolverService）

- v2: `packages/agent-core-v2/src/agent/media/mediaResolver.ts`（约 18 行，读 interface 与 mediaResolverService.ts 实现得出；DI 名沿用历史遗留的 agentVideoResolverService）
- 新架构: `packages/agent-core/src/llm/builtin/policy/store-ref/`（引擎机制）+ `packages/harness-core/src/features/media/feature.ts`（挂载）

## 能力对照

- [x] resolve：把消息中的文件引用按模型能力解析为上传/内联 parts → `packages/agent-core/src/llm/builtin/policy/store-ref/resolve.ts`，经 `packages/harness-core/src/features/media/feature.ts` 的 useMessageResolver(createStoreRefResolver) 挂载
- [x] 上传缓存（按 ref+账号记忆已上传媒体）与进程内 memo → `packages/agent-core/src/llm/builtin/policy/store-ref/session.ts` + `packages/agent-core/src/llm/builtin/policy/store-ref/adapters/blob.ts`（createBlobUploadCache）
- [x] 单请求媒体预算，超限丢弃旧媒体并降级为路径标签 → `packages/agent-core/src/llm/builtin/policy/store-ref/session.ts`（DEFAULT_MEDIA_BUDGET + budgetDropped）
- [x] 模型不支持/上传失败时降级为占位文本 → `packages/agent-core/src/llm/builtin/policy/media-degrade/`（createMediaDegradeRecovery，media feature useLlmRecovery 挂载）
- [x] displayPaths：把媒体 URL 解析为展示路径 → `packages/harness-core/src/features/files/registry.ts`（KimiFileRegistry open/materialize 提供 StoredFile 与元信息，kimi-file:// 体系统一承载）

## 结论

全部对齐（引用解析、上传缓存、请求预算、降级与展示路径均由 agent-core store-ref 机制加 harness media/files 两个 feature 承载）。
