# IAuthSummaryService（authSummaryService）

- v2: `packages/agent-core-v2/src/app/auth/auth.ts`（约 145 行，读 interface 与 authService.ts 的 AuthSummaryService 得出）
- 新架构: `packages/harness-core/src/features/kimi/oauth/feature.ts`（OAuthTokens.summary）

## 能力对照

- [x] summarize()：遍历配置了 oauth 的 provider 并给出登录状态 → OAuthTokens.summary()（feature.ts；含 providers_count、managed_provider 登录态），HTTP 面 GET `{prefix}/auth`（`packages/harness-core/src/feature-http/route-features/auth.ts`）
- [ ] ensureReady(modelOverride)：建会话前的就绪门槛——reload 配置、解析默认/指定模型、校验 provider 配置存在、apiKey/apiKeyEnv/OAuth token 三类凭证可用，并按 AuthProvisioningRequired / AuthModelNotResolved / AuthTokenMissing / AuthCredentialEnvMissing 分类抛错（v2 消费方为 kap-server 建 session 路由与 acp-server）— 新栈两包内无等价门槛，仅有 summary() 返回的 models_ready 布尔，未对齐（归属 kap-server/acp-server 调用面未迁）

## 结论

未对齐 1 项——状态汇总已由 oauth.summary + /auth 路由承载；带分类错误的 ensureReady 就绪门槛在新栈两包内缺失。
