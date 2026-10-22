# IHostRequestHeaders（hostRequestHeaders）

- v2: `packages/agent-core-v2/src/llm-adapter/model/host-request-headers.ts`（约 9 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/kimi/web/feature.ts`（createWebSlots 的 defaultHeaders 组合）

## 能力对照

- [x] Kimi 身份请求头（headers：User-Agent 与设备身份头）→ `packages/oauth/src/identity.ts` 的 createKimiDefaultHeaders（KimiIdentityOptions），在 `packages/harness-core/src/features/kimi/web/feature.ts:54` 注入
- [x] 环境自定义头（v2 由宿主注入合并）→ `@moonshot-ai/kimi-code-oauth` 的 parseKimiCodeCustomHeaders（web/feature.ts defaultHeaders 内合并，最低优先级层）
- [x] 身份标识（identitySlug）→ `packages/oauth/src/identity.ts` 的 KimiIdentityOptions / KimiHostIdentity 字段（product 等经 createKimiUserAgent 进入 User-Agent）
- [x] 第三方 provider 头（thirdPartyHeaders）→ 结构取代：不再有统一服务，第三方头经 provider 配置 customHeaders 与各 protocol requester 自带身份头承载（`packages/harness-core/src/features/provider-catalog/feature.ts` 的 useProviderProtocol 装配）

## 结论

全部对齐：统一 headers 服务被「kimi identity 层（oauth 包）+ 宿主注入 + provider 级 customHeaders」的分散结构取代，各消费面均有承载。
