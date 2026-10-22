# IBuiltinAgentProfileLoader（builtinAgentProfileLoader）

- v2: `packages/agent-core-v2/src/app/agentProfileCatalog/builtinAgentProfileLoader.ts`（约 16 行，读 interface 与 builtinAgentProfileLoaderService.ts 得出）
- 新架构: `packages/harness-core/src/features/profiles/builtin.ts`（BUILTIN_PROFILES 静态表 + createBuiltinFinder）

## 能力对照

- [x] 内置 profile 静态目录（agent / coder / explore / plan 四个，与 v2 注册来源 profiles.ts×3 + plan.ts×1 一致）→ `packages/harness-core/src/features/profiles/builtin.ts`（BUILTIN_PROFILES）
- [x] `get(name)` 按名取内置 profile → ProfileCatalogFace.get（`packages/harness-core/src/features/profiles/feature.ts`）；纯内置场景另有 `createStaticProfileCatalog`（`packages/harness-core/src/features/spawn/profile.ts`）
- [x] `getDefault()` 取默认 profile（缺省抛错）→ `getBuiltinDefaultProfile()`（builtin.ts）与 ProfileCatalogFace.getDefault（feature.ts）
- [x] `list()` 列举全部内置 profile → ProfileCatalogFace.list；内置来源经 `createBuiltinFinder()` 汇入目录（feature.ts）
- [x] 内置来源向全局目录贡献（v2 构造函数内向 AgentProfileContribution 供记录）→ `useProfileFinder(createBuiltinFinder())`（feature.ts）

## 结论

全部对齐——内置目录由「DI loader 服务」改为「静态表 + finder 贡献 + 目录 facade」，四个内置 profile 与默认 profile 语义保持一致。
