# IOAuthToolkit（oauthToolkit）

- v2: `packages/agent-core-v2/src/app/auth/auth.ts`（约 145 行，读 interface 与 authService.ts 末尾 OAuthToolkitService 得出；实现即 `KimiOAuthToolkit` 子类，注入 homeDir 与 clientIdentity）
- 新架构: `packages/harness-core/src/features/kimi/oauth/tokens.ts`（createOAuthTokenResolver：OAuthManager + FileTokenStorage）

## 能力对照

- [x] login/logout（设备码登录、登出删 token）→ OAuthManager.login/logout，经 managerFor 缓存复用（tokens.ts）
- [x] getCachedAccessToken/tokenProvider（缓存 token 读取与 BearerTokenProvider 供给）→ resolver.resolve(ref) 返回 BearerTokenProvider（ensureFresh，支持 force）（tokens.ts）
- [x] getManagedUsage/getManagedUserInfo → oauth feature 内 fetchManagedUsage/fetchManagedUserInfo 封装为 facade.usage/userinfo（`packages/harness-core/src/features/kimi/oauth/feature.ts`）
- [ ] `OAuthRef.storage = 'keyring'` 后端 — v2 配置 schema（kosongConfig/auth configSection）允许 storage 取 'keyring'，但 oauth 包只有 FileTokenStorage 一种实现；新栈 tokens.ts 的 managerFor 对 `ref.storage !== 'file'` 直接返回 undefined（调用方表现为静默无 token）。该 keyring 后端记录在案未迁

## 结论

未对齐 1 项——文件存储下的登录/token/用量能力已由 OAuthManager + resolver 承载；keyring 存储后端两侧均只有类型没有实现，新栈仍未补齐。
