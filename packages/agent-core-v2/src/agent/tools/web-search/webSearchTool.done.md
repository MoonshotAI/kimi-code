# IWebSearchTool（webSearchTool）

- v2: `packages/agent-core-v2/src/agent/tools/web-search/web-search.ts`（约 33 行；实现 webSearchTool.ts 约 118 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/kimi/web/`（feature.ts / provider.ts / tool.ts / configSection.ts）

## 能力对照

- [x] 按 query 搜索并格式化结果（Title/Site/Date/URL/Snippet + 引用提醒、无结果提示）→ `packages/harness-core/src/features/kimi/web/tool.ts`（formatSearchResults 与 v2 文案一致）
- [x] provider 解析链：services 配置 moonshot_search → managed OAuth；无 provider 时工具不注册（对应 v2 的 when: hasWebSearchProvider 门控）→ `packages/harness-core/src/features/kimi/web/feature.ts`
- [x] 错误分类文案（cancelled/timed out/authentication/network）→ `packages/harness-core/src/features/kimi/web/tool.ts`（classifySearchError 与 v2 一致）
- [x] 审批规则（按 query 做 glob 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（WebSearch 条目）

## 结论

全部对齐。
