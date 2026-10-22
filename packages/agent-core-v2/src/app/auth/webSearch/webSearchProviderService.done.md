# IWebSearchProviderService（webSearchProviderService）

- v2: `packages/agent-core-v2/src/app/auth/webSearch/webSearch.ts`（约 15 行，读 interface 与 webSearchService.ts 得出）
- 新架构: `packages/harness-core/src/features/kimi/web/feature.ts`（WebSearchRef facade + agent 级 WebSearch 工具注册）

## 能力对照

- [x] getWebSearchProvider()：`services` 节 moonshot_search 配置优先、托管 OAuth（kimi-code provider 的 oauth token + baseUrl/search）兜底 → WebSearchRef.getProvider（fromServicesConfig ?? fromManagedOAuth，feature.ts；配置节见 `packages/harness-core/src/features/kimi/web/configSection.ts`）
- [x] hasWebSearchProvider() → getProvider() !== undefined 判定（同一解析路径，feature.ts）
- [x] 出站默认请求头（v2 取 IAgentIdentity 快照的 requestHeaders）→ 宿主注入 identity props，`createKimiDefaultHeaders(props.identity)` + `KIMI_CODE_CUSTOM_HEADERS` env（feature.ts 的 defaultHeaders）
- [x] provider 向 agent 暴露为 WebSearch 工具 → agent 级 slot：`useAgentTools(createWebSearchTool(web))`（feature.ts agent() + `packages/harness-core/src/features/kimi/web/tool.ts`）

## 结论

全部对齐——解析顺序（services 节优先、托管 OAuth 兜底）与工具暴露均保留，DI 服务转为 web feature 的 WebSearchRef facade。
