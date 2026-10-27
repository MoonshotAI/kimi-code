# IAgentIdentity（agentIdentity）

- v2: `packages/agent-core-v2/src/app/agentIdentity/agentIdentity.ts`（约 72 行，读 interface 与 agentIdentityService.ts 得出）
- 新架构: 无集中对应服务；身份改为宿主以 props 注入各 feature（如 `packages/harness-core/src/features/kimi/web/feature.ts` 的 `identity?: KimiIdentityOptions`）

## 能力对照

- [x] 出站请求身份头（User-Agent + X-Msh-* 设备头）注入 web search / fetch 等出站调用 → `packages/harness-core/src/features/kimi/web/feature.ts`、`packages/harness-core/src/features/kimi/fetch/feature.ts`（`createKimiDefaultHeaders(props.identity)`）
- [x] 模型目录刷新请求的 User-Agent 注入 → `packages/harness-core/src/features/models-dev/feature.ts`（userAgent prop）+ `packages/harness-core/src/features/provider-catalog/refresh.ts`（`ProviderRefreshUserAgents` collection）
- [x] ACP 握手中的宿主实现标识 → `packages/harness-core/src/feature-acp/server.ts`（`agentInfo` prop）
- [x] HTTP 服务版本标识 → `packages/harness-core/src/feature-http/feature.ts`（`version` prop，meta 路由输出 server_version）
- [ ] `[identity]` 配置节（name/slug，含 `KIMI_CODE_IDENTITY_NAME` / `KIMI_CODE_IDENTITY_SLUG` env 绑定，见 v2 configSection.ts）— 新栈两包内无该配置节，缺失
- [ ] slug 归一化（normalizeIdentitySlug）与按 slug 重写出站 UA product（buildAgentIdentitySnapshot 经 replaceUserAgentProduct）— 新栈仅把宿主给定的 headers 原样透出，不做身份改写，缺失

## 结论

未对齐 2 项——出站身份头的「注入通道」已由宿主 props 承载，但 v2 的 `[identity]` 配置节与 slug 归一化/UA 重写能力在新栈两包内找不到等价物。
