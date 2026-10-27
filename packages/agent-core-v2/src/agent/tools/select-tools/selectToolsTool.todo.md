# ISelectToolsTool（selectToolsTool）

- v2: `packages/agent-core-v2/src/agent/tools/select-tools/select-tools.ts`（约 18 行；实现 selectToolsTool.ts 约 121 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/tool-select/`（feature.ts / state.ts / tool.ts / resolver.ts）

## 能力对照

- [x] 按名动态加载工具（Loaded / Already available / Unknown 回报）→ `packages/harness-core/src/features/tool-select/tool.ts`、`state.ts`
- [x] <tools_added>/<tools_removed> 公告与加载后 schema 按需注入 → `packages/harness-core/src/features/tool-select/feature.ts`（remind 公告 + DYNAMIC_TOOL_SCHEMA_REMINDER_KEY 注入）、`resolver.ts`
- [x] 模型能力门控（dynamically_loaded_tools；不支持时回退为直接注册全部工具）→ `packages/harness-core/src/features/tool-select/state.ts`（isToolSelectEnabled）、`feature.ts`
- [x] 未加载即调用时的引导报错 → `packages/harness-core/src/features/tool-select/tool.ts`（deferTool）
- [x] 审批规则（name-only）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（select_tools 条目）
- [ ] 错误恢复引导文案 — 降级：v2 的 alreadyCallable / staleLoaded / policyDenied / "Did you mean" 建议 / 连续失败升级提示（escalated、consecutiveFailures≥3）未迁，新栈仅回报 Loaded/Already available/Unknown 三类

## 结论

未对齐 1 项——错误恢复引导文案降级；动态加载主链路已对齐。
