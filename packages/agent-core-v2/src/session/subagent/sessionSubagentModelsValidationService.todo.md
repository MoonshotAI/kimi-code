# ISessionSubagentModelsValidationService（sessionSubagentModelsValidationService）

- v2: `packages/agent-core-v2/src/session/subagent/subagentModelsValidation.ts`（约 10 行；interface 为空，能力读实现 subagentModelsValidationService.ts 约 28 行得出）
- 新架构: 无对应（包内）

## 能力对照

- [ ] 会话启动期校验 subagent 模型池配置（`assertValidSubagentModelConfig(config, modelCatalog)`：secondaryModel 配置引用的模型必须存在于模型目录，thinking/effort 合法性）— 归属宿主层未迁：新栈模型池由宿主经 `createSpawn({ models })` props 注入（`packages/harness-core/src/features/spawn/plan.ts` 的 `SpawnModelEntry`），两个包内无配置段解析与启动期校验；仅 `planSpawn.resolveSpawnModel` 在请求期校验模型名是否在池中
- [x] 请求期模型名校验（v2 由 planSpawn 前的配置校验间接保证）→ `packages/harness-core/src/features/spawn/plan.ts`（`resolveSpawnModel`：未知模型名给出可用列表报错；空池时提示只能继承）
- [ ] 配置段 schema 声明（v2 configSection.ts 的 `secondaryModel` zod schema 与 `subagent.timeoutMs`）— 归属宿主层未迁：新栈两个包内无对应配置段，模型条目由宿主解析后直接传入
- [x] 模型池耗尽时的降级语义（v2 校验保证池非空或报错）→ `packages/harness-core/src/features/spawn/plan.ts`（空池时显式报「no subagent model pool is configured」，引导省略 model 参数）

## 结论

未对齐 2 项——启动期配置校验与配置段 schema 均未迁（配置解析归属宿主层，包内只剩请求期校验）。
