# IModelOAuthTokens（modelOAuthTokens）

- v2: `packages/agent-core-v2/src/llm-adapter/model/model-oauth.ts`（约 17 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/kimi/oauth/tokens.ts`（OAuthTokens facade）

## 能力对照

- [x] 缓存令牌探测（hasCachedAccessToken）→ `packages/harness-core/src/features/kimi/oauth/tokens.ts` 的 OAuthTokens.hasCachedAccessToken
- [x] 取访问令牌（getAccessToken，支持 force 刷新）→ tokens.ts 的 OAuthTokens.resolve(ref) 返回 BearerTokenProvider，getAccessToken({ force }) 经 OAuthManager.ensureFresh 实现（createOAuthTokenResolver）
- [x] 按 provider+OAuthRef 寻址令牌存储（file/keyring、oauthHost）→ tokens.ts 的 CatalogOAuthRef（storage/key/oauthHost）与 resolveKimiTokenStorageName 解析
- [x] 多 OAuth 管理器缓存（v2 由服务内 Map 承担）→ tokens.ts 的 createOAuthTokenResolver 按 `name\0oauthHost` 缓存 OAuthManager 实例

## 结论

全部对齐：模型 OAuth 令牌读取由 kimi/oauth feature 的 OAuthTokens facade 完整承载，force 刷新语义一致；登入/登出/用量查询等周边能力亦在同 facade（loginStart/logout/usage）。
