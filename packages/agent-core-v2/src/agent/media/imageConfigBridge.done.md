# IImageConfigBridge（imageConfigBridge）

- v2: `packages/agent-core-v2/src/agent/media/imageConfigBridge.ts`（约 47 行，声明与实现同文件）
- 新架构: `packages/harness-core/src/features/media/state/configSection.ts`

## 能力对照

- [x] 注册 image 配置节（maxEdgePx / readByteBudget）→ `packages/harness-core/src/features/media/state/configSection.ts`（imageConfigSection，由 `packages/harness-core/src/features/media/feature.ts` 在 app 层 useConfigSection）
- [x] KIMI_IMAGE_MAX_EDGE_PX / KIMI_IMAGE_READ_BYTE_BUDGET 环境变量绑定 → `packages/harness-core/src/features/media/state/configSection.ts`（imageEnvBindings + stripEnv）
- [x] 配置生效到图片读取/压缩限额（v2 推入 image-compress 静态值；新栈在使用点 resolveImageLimits 惰性取值，能力等价）→ `packages/harness-core/src/features/media/feature.ts`（resolveImageLimits 供 ReadMediaFile 工具与 intake 使用）
- [x] env 解析失败回退默认限额（正整数校验、缺省 MAX_IMAGE_EDGE_PX / READ_IMAGE_BYTE_BUDGET）→ `packages/harness-core/src/features/media/state/configSection.ts`（parsePositiveInt + resolveImageLimits）+ `packages/harness-core/src/features/media/transform/compress.ts`

## 结论

全部对齐（配置节、env 绑定与限额生效路径均在新栈 media feature 承载，仅推送式改惰性求值的实现差异）。
