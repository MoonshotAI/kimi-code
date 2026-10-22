# IOAuthService（oauthService）

- v2: `packages/agent-core-v2/src/app/auth/auth.ts`（约 145 行，读 interface 与 authService.ts 得出）
- 新架构: `packages/harness-core/src/features/kimi/oauth/feature.ts`（OAuthTokens facade，HTTP 面见 `packages/harness-core/src/feature-http/route-features/auth.ts`）

## 能力对照

- [x] 设备码登录流（startLogin：先 abort 同 provider 在途流、deviceReady/fastPath 竞速、终态保留后 GC）→ OAuthTokens.loginStart（feature.ts）
- [x] 登录流查询与取消（getFlow/cancelLogin）→ loginStatus/loginCancel；HTTP 路由 GET/DELETE `{prefix}/oauth/login`（route-features/auth.ts）
- [x] 登出并清理托管配置（logout + deprovision：删 provider/models/services、清悬空 defaultModel/thinking）→ logout + deprovisionAfterLogout（feature.ts）
- [x] 登录状态查询（status → 缓存 token 判定）→ hasCachedAccessToken（facade）
- [x] 刷新 OAuth 托管模型目录（refreshOAuthProviderModels：拉取托管 models、保留用户别名与默认选择、发布目录变更）→ facade.refresh() → provider-catalog `store.refresh({ scope: 'oauth' })`（`packages/harness-core/src/features/provider-catalog/feature.ts`）
- [x] 托管用量与用户资料（getManagedUsage/getManagedUserInfo）→ usage/userinfo；路由 GET `{prefix}/oauth/usage`、`{prefix}/oauth/userinfo`
- [x] 运行时 token 提供（resolveTokenProvider/getCachedAccessToken，含 oauthRef 解析）→ tokens.resolve + `useProviderOAuthTokenResolver` / `useCredentialResolver` 桥接进 provider-catalog 凭证链（feature.ts）
- [x] 区域判定（getRegion：oauthHost/key 配置 + KIMI_CODE_REGION_MARKER + homeDir 标记）→ region()；路由 GET `{prefix}/oauth/region`
- [x] 登录成功后 provision（写入 kimi 类型 provider 配置、刷新目录、补默认模型）→ provisionAfterLogin + healDefaultModelAfterManagedLogin（feature.ts）

## 结论

全部对齐——DI 服务转为 oauth feature 的 OAuthTokens facade，登录/provision/刷新/用量各能力逐项有承载，HTTP 面由 feature-http 路由暴露。
