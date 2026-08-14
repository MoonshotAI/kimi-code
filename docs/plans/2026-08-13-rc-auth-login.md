# Remote Control 鉴权登录页(apps/auth-login)实施方案

> 2026-08-13。Remote Control(RC)链路的鉴权中间页:只承载「Kimi Code OAuth 登录 + 重定向」,移动端优先、响应式兼容 PC。已拍板决策:
>
> 1. 页面放 **code-app 仓内**,新 app 目录名 **`apps/auth-login`**。
> 2. 登录逻辑**复用 kimi-code 仓的 `@moonshot-ai/kimi-code-oauth` 包**(device code flow),浏览器直连 `auth.kimi.com`;token 存 cookie。
> 3. cookie 契约:名 **`kimi-auth`**;回跳参数名 **`redirect_uri`**。
> 4. UI 与 web/desktop 同源(`@moonshot-ai/app-ui` tokens + 原语,Kimi 风格)。
> 5. kimi-code 侧所需的 oauth 包改动由本人完成,工作克隆选干净的那个(见下文)。

## 背景:Remote Control 链路

1. 远程机器本地执行 TUI 的 `/rc` 命令 → 启动本地 server + kimi code web 服务。
2. 请求在线服务 `kimi.com/rc` → 把本地 ip:port 转发到公网。
3. 远端用户(手机)访问公网地址 → **先经过一层鉴权**:用 Kimi Code 的 OAuth 登录,通过后才能访问。

本方案只覆盖第 3 步里的**鉴权中间页**:隧道入口发现无有效凭证 → 跳转到本页(带 `redirect_uri`)→ 本页完成 OAuth device flow → 写 cookie → 跳回 `redirect_uri`。隧道服务本身的鉴权校验、`/rc` 命令、`kimi.com/rc` 转发服务均不在本方案范围。

## 已验证的事实(2026-08-13 实测 / 代码引用为准)

- **CORS 全通**:`OPTIONS https://auth.kimi.com/api/oauth/device_authorization` 与 `/api/oauth/token` 均返回 `access-control-allow-origin: *`,`content-type` / `x-msh-platform` 头放行。移动端浏览器直连 auth.kimi.com 无障碍。
- **授权确认页已存在,不在本方案范围**:真实调用 `POST /api/oauth/device_authorization`(client_id `17e5f671-d194-4dfb-9706-5516cb48c098`)返回 `verification_uri = https://www.kimi.com/code/authorize_device`。用户在手机浏览器打开该页完成「登录账号 + 确认授权」,我们不做这个页面。实测该接口**不带 `X-Msh-*` 头也成功**,设备头可选。
- **oauth 包的浏览器可用性**(`kimi-code/packages/oauth/src`):
  - `oauth.ts` 的 `requestDeviceAuthorization` / `pollDeviceToken` / `refreshAccessToken` 是纯 `fetch` 封装;依赖闭包(`api-error.ts` / `errors.ts` / `types.ts` / `utils.ts` / `constants.ts`)均无 Node import——**浏览器安全**。
  - 但顶层 `index.ts` barrel 会拖进 `OAuthManager`(`node:fs` / `proper-lockfile`)、`identity.ts`(`node:os` / `node:child_process`)、`toolkit.ts`、`storage.ts`——**浏览器 import 包根会炸**,必须加浏览器安全的子路径 export。
  - `tsdown.config.ts` 单入口 `./src/index.ts`;加子路径需同步加 entry。
  - `KIMI_CODE_FLOW_CONFIG`(oauthHost + clientId)由 `constants.ts` 导出,纯模块,直接复用——授权页显示的就是 Kimi Code,语义正确。
- **workspace**:`pnpm-workspace.yaml` 已含 `kimi-code/packages/*`,新 app 按包名 `workspace:*` 依赖即可,符合「只经包名 import」硬约束。
- **状态机复用**:`useOAuthLoginFlow`(`packages/app-client/src/composables/useOAuthLoginFlow.ts`)是回调注入式 device-flow 状态机(starting → device-code → success/expired/error、倒计时、轮询三连败容错、disposed 清理),埋点 `track` 默认 no-op(`contracts.ts` 的 `noopProductTracker`)。新 app 直接复用,回调改为直连 oauth 包,零重写。
- **既有约定要守住**:授权完成页读 `from=kimi_code_desktop` 渲染「打开 App」按钮并跳 `kimi-code://auth/success`(`apps/desktop/src/renderer/lib/loginSource.ts`、`apps/desktop/src/main/deep-link.ts`)。RC 场景**不带** `from` 参数(裸 URL),该按钮保持隐藏。

## kimi-code 侧改动(一个小 PR)

**工作克隆选择**(2026-08-13 核查):

| 克隆 | 分支 | 状态 | 结论 |
|---|---|---|---|
| kimi-code-2 | feat/oauth-region-split | 3 脏文件 | 有任务,不动 |
| kimi-code-3 | fix/sdk-retry-cancel | 干净但在任务分支 | 有任务,不动 |
| kimi-code-5 | auto-title | 4 脏文件 | 有任务,不动 |
| kimi-code-tips | feat/upgrade-reminder-banner | 2 脏文件 | 有任务,不动 |
| kimi-code-ky | main | 干净但不可用(拍板排除) | 不动 |
| kimi-code / kimi-code-4 | main | 干净、无未推送、node_modules 齐 | 候选 |

**选用 `~/Desktop/moonshot/kimi-code-4`**(干净 main;备选 kimi-code),工作分支 `feat/oauth-device-subpath-export`。

改动(`packages/oauth`,均为新增导出,无行为变更):

1. 新建 `src/device.ts`:re-export 浏览器安全闭包——`./oauth` 的三函数与 `DevicePollResult` 类型、`./constants` 的 `KIMI_CODE_FLOW_CONFIG`、`./types` 的相关类型(`DeviceAuthorization` / `TokenInfo` / `OAuthFlowConfig` / `OAuthRequestHeaders`)、`./errors` 的错误类。
2. `package.json` `exports` 增加:`"./device": { "types": "./src/device.ts", "default": "./src/device.ts" }`。
3. `tsdown.config.ts` `entry` 增加 `./src/device.ts`(dist 双产物)。
4. 验证:`pnpm --filter @moonshot-ai/kimi-code-oauth typecheck`、`build`,以及 oauth 包既有测试全绿。
5. PR 标题:`feat(oauth): add browser-safe ./device subpath export`(Conventional Commits,无署名)。

## code-app 侧改动

### 新 app `apps/auth-login`

**形态**:Vue 3 + Vite + TS strict,无 router、无 Pinia,vue-i18n v11(Composition 模式,`legacy: false`,fallback `en`,跟随浏览器 locale)。pnpm workspace 成员,private。

**依赖**:

- `@moonshot-ai/app-ui`(tokens + Button / Spinner / Icon 原语;`src/style.css` import `@moonshot-ai/app-ui/style.css`)
- `@moonshot-ai/app-client`(`useOAuthLoginFlow`)
- `@moonshot-ai/kimi-code-oauth`(**只经 `./device` 子路径** import)
- `vue` / `vue-i18n`;dev 依赖 `@moonshot-ai/vite-preset`、`@vitejs/plugin-vue`、`vite`、`typescript`、`vue-tsc`、`vitest`

**vite 配置**:复用 `kimiRendererViteConfig`(iconsDir 指向 app-client 的 kimi 图标目录,同 apps/web 的做法);`base: './'`(产物可挂任意路径);**无 dev proxy**(浏览器直连 auth.kimi.com,无需代理);独立端口(如 `5176`,env `AUTH_LOGIN_PORT` 可调)。

**文件结构**:

```
apps/auth-login/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html               # viewport-fit=cover、页面标题、noindex
├── src/
│   ├── main.ts              # 启动 + i18n 安装
│   ├── App.vue              # 单页状态机 UI(复用 useOAuthLoginFlow)
│   ├── flow.ts              # 回调适配:useOAuthLoginFlow ← oauth 包直连
│   ├── auth-token.ts        # cookie 读写 + redirect_uri 解析校验(纯函数,可测)
│   ├── style.css            # import app-ui tokens + 页面级样式
│   └── i18n/
│       ├── index.ts
│       └── locales/{en,zh}.ts
└── test/
    └── auth-token.test.ts   # cookie / redirect_uri 纯函数测试
```

**页面状态机**(进入页面即跑):

```
1. checking:读 cookie kimi-auth
   → 存在且未过期:有 redirect_uri → 立即 location.replace 回跳;无 → 显示「已登录,可关闭本页」
2. 无/过期 → startFlow():
   requestDeviceAuthorization(flowConfig(), { deviceHeaders: 见「请求身份」节 })
3. device-code:
   - 主按钮「前往授权」新标签打开 verification_uri_complete(authorize_device 页)
   - 展示 user_code + 复制授权链接(二次路径,同 LoginDialog 的 parked 思路)
   - 倒计时(expires_in 1800s)+ 轮询(pollDeviceToken,server 建议 interval=5s,三连败转 error)
4. success:无条件写 cookie;有 redirect_uri → location.replace 回跳,无 → 停留显示「登录成功,可关闭本页」
5. expired / error:提示 + 重试按钮(重新 startFlow)
```

**cookie 写入**(`auth-token.ts`):

- `kimi-auth=<access_token>`;`Path=/`;`Secure`;`SameSite=Lax`(顶级导航跳转需携带);`Expires` = token 的 `expiresAt`。
- 只存 access token(拍板);过期后隧道侧 401 → 再跳回本页 → 重走 device flow(authorize_device 页有会话时确认一键完成,体验可接受)。
- refresh token 不落 cookie;页面生命周期短(登录即跳走),无需 refresh 逻辑。

**请求身份(拍板)**:

- `X-Msh-Platform: kimi_code_cli`(**拍板沿用 CLI 的值**,不新造 RC 专属 platform);`X-Msh-Version` = auth-login 自身版本;`X-Msh-Device-Id` = localStorage 持久化的 `crypto.randomUUID()`(首次访问生成,语义等价 CLI 的 device_id 文件)。`Device-Name` / `Device-Model` / `Os-Version` 浏览器拿不到准确值,不伪造、不带(实测不带头接口也正常,头是可选统计维度)。
- `User-Agent`:**一定会传,且 JS 无法干预**——`User-Agent` 是浏览器 forbidden header,fetch 既改不了也删不掉,每个请求自动携带用户浏览器的原生 UA(iPhone Safari / Android Chrome 等)。Node 侧 CLI/desktop 经 `createKimiDefaultHeaders` 把产品 UA 注入 `deviceHeaders`(`kimi-code-cli/x.y.z`);浏览器里即使写这个键也会被 fetch 静默丢弃,所以页面不传。最终服务端看到的 RC web 流量 = `X-Msh-Platform: kimi_code_cli` + 浏览器原生 UA,按 UA 仍可区分出浏览器形态。
- 自定义头触发 CORS preflight;`x-msh-platform` 已实测被服务端回显放行(动态回显),其余头实施时顺手验证。

**redirect_uri 处理(可选)**:

- `redirect_uri` **不必填**:隧道场景由隧道跳转时拼在登录地址上带来;直接访问(无参)也正常走登录流程。
- 仅允许 `https:` / `http:`(拒绝 `javascript:` 等);缺失或非法一律按「无跳转目标」宽容降级,不阻塞登录。
- 授权成功后 **cookie 无条件写入**;有 `redirect_uri` 才 `location.replace` 回跳,无则停留显示「登录成功,可以关闭本页」。已持有有效 cookie 直接进入时同理:有参跳走,无参显示已登录态。
- 隧道域名动态生成,不做白名单;token 只经 cookie 传递、不上 URL,跳转本身不带敏感信息,开放重定向风险可控。

**移动端 / 响应式**:

- 页面无文本输入框(user_code 是展示),天然规避 iOS 聚焦缩放与键盘遮挡问题。
- `viewport-fit=cover` + `env(safe-area-inset-*)` 上下安全区;触控目标 ≥ 44px。
- 移动端纵向居中卡片全宽;`≥640px` 桌面居中窄卡片(约 400px),内容同构。
- 同设备旅程:「前往授权」开新标签 → 授权 → 切回本标签时轮询已成功 → 自动跳走;授权页标签由用户自行关闭(与 desktop LoginDialog 同模式)。
- 亮/暗双主题:跟随系统(`data-color-scheme` 模式,token 自动适配),亮暗两态都要视觉验证。

**样式纪律**:全部走 `--color-*` / `--space-*` / `--text-*` / `--radius-*` token,零 ad-hoc 值;UI 实现前读 `kimi-design-skill` 移动端规范与 `apps/desktop/src/renderer/views/DesignSystemView.vue`。

### 双仓工作流顺序

1. **kimi-code-4**:oauth 包子路径 export 改动 → typecheck/build/test → 推送分支、提 PR。
2. **code-app 联调**:`kimi-code/` submodule `git fetch origin feat/oauth-device-subpath-export && git checkout <commit>`,auth-login 即可经 `./device` 子路径 import 开发。
3. kimi-code PR merge 后:submodule checkout 到 main 的新 commit,`git add kimi-code` bump(单独 commit)。
4. **auth-login 开发**:脚手架 → flow/cookie 纯函数 + 测试 → UI → i18n → 双主题视觉验证。
5. 验证:`pnpm typecheck`、`pnpm lint`、auth-login 的 `vitest`;`pnpm dev` 起页面真实走一遍 device flow(桌面浏览器 + 手机各一遍),确认 cookie 写入与回跳。

### changeset

auth-login 独立于 desktop(`kimi-code-app`)发版,产物为静态页、不进 release CI。初步判断本改动对 kimi-code-app 无用户可见变化、**不需要 changeset**;提 PR 前按 `changeset` skill 规则最终确认。

## 明确不做

- 不做授权确认页(`www.kimi.com/code/authorize_device` 已存在)。
- 不动隧道服务鉴权逻辑、`/rc` 命令、`kimi.com/rc` 转发服务;cookie 契约以拍板为准。
- 不接 telemetry(`track` 保持 no-op);不存 refresh token;不做登录态管理页。

## 风险与备注

- **CORS 后续收紧**:当前 `*` 且无凭证请求,风险低;若收紧,退路是 RC 服务同域反代 auth.kimi.com 接口(页面只改 baseURL)。
- **authorize_device 页的移动端体验**归其所属团队;若发现该页移动端不适配,会影响整体旅程,需反馈——本方案不绕开它。
- **cookie 域**:cookie 写在页面当前域,要求登录页与隧道入口同域部署(部署侧职责,产物用 `base: './'` 适配)。
- **子路径 export 是新增面**:kimi-code 侧只加 export 不动行为,对 CLI/desktop 零影响。
