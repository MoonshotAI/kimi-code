# IConfigService（configService）

- v2: `packages/agent-core-v2/src/app/config/config.ts`（约 224 行，读 interface 与 configService.ts 得出）
- 新架构: `packages/harness-core/src/features/config/store.ts`（ConfigStore facade，经 ConfigRef 暴露）

## 能力对照

- [x] ready（加载完成门）→ feature 内 `useReady(store.reload())`（`packages/harness-core/src/features/config/feature.ts`）
- [x] get/inspect（value/defaultValue/userValue/memoryValue 四层）→ ConfigStore.get/inspect（store.ts）
- [x] set/replace/reload/diagnostics → ConfigStore 同名方法（store.ts）
- [x] 变更通知（v2 onDidChangeConfiguration/onDidSectionChange）→ `config.changed` 运行时事件（feature.ts；section/value/previousValue/source）
- [x] 响应式节读取 → ConfigStore.section(name) 返回 ShallowRef（store.ts）
- [x] 磁盘 snake_case 与注释/格式保留写回 → toml.ts + `packages/harness-core/src/features/config/writeback.ts`（行级 replace/insert 规划，trivia 段原样保留）
- [x] legacy 形态归一与别名解析 → `packages/harness-core/src/features/config/sections.ts`（fromToml 转换、providers 的 aliases 字段）+ provider-catalog 的 matchCatalogBinding
- [x] env 覆盖层与 stripEnv 写回剥离 → `packages/harness-core/src/features/config/env.ts`（applySectionEnv）+ overlay.strip（store.ts）
- [x] 未注册节透传（写回保留未知节）→ store 写回基于完整 rawSnake 仅改动目标域行区（store.ts/writeback.ts）
- [x] 配置文件 watch 自动 reload（150ms 去抖）→ feature.ts（persist.watch）
- [ ] getAll() 全量解析快照（v2 经 kap-server GET /api/v1/config 对外暴露）— 新栈 ConfigStore 无 getAll，feature-http 亦无 config 路由，归属 kap-server 暴露面未迁
- [ ] replaceSections 的写入选项（expectedValues 比较交换、exactKeys 精确键合并、preserveUnknown；v2 用于服务端并发写保护）— 新栈 replace(sections, target) 无选项参数，未对齐

## 结论

未对齐 2 项——读写/响应式/磁盘格式主链路完整对齐；全量快照出口与并发写保护选项未见等价。
