# IAuthLegacyService（authLegacyService）

- v2: `packages/agent-core-v2/src/app/authLegacy/authLegacy.ts`（约 33 行，读 interface 与 authLegacyService.ts 得出）
- 新架构: `packages/harness-core/src/features/kimi/oauth/feature.ts`（OAuthTokens.summary）+ `packages/harness-core/src/feature-http/route-features/auth.ts`（GET `{prefix}/auth`）

## 能力对照

- [x] GET /auth 就绪快照 `{models_ready, providers_count, managed_provider}`（v2 经 kap-server GET /api/v1/auth 暴露）→ OAuthTokens.summary()，字段与枚举逐一对应（AuthSummary 定义见 `packages/harness-core/src/features/kimi/oauth/auth.ts`，managed_provider.status 同取 authenticated/expired/revoked/unauthenticated）
- [x] models_ready 判定（默认模型可解析到可用 provider）→ summary 内 `matchCatalogBinding(defaultModel, bindings)`（feature.ts，基于 provider-catalog 的目录绑定）
- [x] managed_provider 登录态（kimi-code provider 存在时按缓存 token 判 authenticated/unauthenticated）→ summary 内 managedLoggedIn（feature.ts）

## 结论

全部对齐——legacy 服务缝本身不迁，其 GET /auth 能力已并入 oauth feature 的 summary() 并由 feature-http 同名路由暴露，响应形状一致。
