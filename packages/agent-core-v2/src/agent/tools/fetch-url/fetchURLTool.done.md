# IFetchURLTool（fetchURLTool）

- v2: `packages/agent-core-v2/src/agent/tools/fetch-url/fetch-url.ts`（约 15 行；实现 fetchUrlTool.ts 约 79 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/kimi/fetch/`（feature.ts / tool.ts / local.ts / moonshot.ts）

## 能力对照

- [x] 按 URL 抓取正文（passthrough 原文 / extracted 主文本两种形态及对应说明文案）→ `packages/harness-core/src/features/kimi/fetch/tool.ts`、`fetcher.ts`
- [x] fetcher 选择链：services 配置 moonshot_fetch → managed OAuth → local 兜底 → `packages/harness-core/src/features/kimi/fetch/feature.ts`（fromServicesConfig / fromManagedOAuth / local）
- [x] 空响应处理、HTTP 状态错误与网络错误分类文案、Markdown 引用提醒 → `packages/harness-core/src/features/kimi/fetch/tool.ts`
- [x] 审批规则（按 URL 做 glob 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（FetchURL 条目）

## 结论

全部对齐。
