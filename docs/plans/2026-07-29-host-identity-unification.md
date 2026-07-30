# 宿主身份统一实施方案（Host Identity Unification）

日期：2026-07-29
状态：已评审定稿，待实施
涉及仓库：`code-app`（本仓）、`kimi-code`（核心仓，工作克隆 `~/Desktop/moonshot/kimi-code-5` 实施）
关联：deep link 唤起桌面端（PR #156）、OAuth device flow 授权页「打开桌面端」按钮

---

## 1. 现状与问题

### 1.1 背景

「OAuth 授权完成后唤起桌面端」需求引出宿主身份梳理：授权页需要知道 device flow 来自哪个客户端（桌面端 / CLI / web），才能决定是否渲染「打开 Kimi Code 桌面端」按钮。排查发现身份传递链路（User-Agent、`X-Msh-*` 设备头、telemetry、版本上报、系统提示词产品名）存在系统性混乱，且有真实的值缺失 bug。

涉及的概念：

- **transport 身份**：`User-Agent` + `X-Msh-*` 六个设备头（Platform / Version / Device-Name / Device-Model / Os-Version / Device-Id），随模型推理、WebSearch/WebFetch、OAuth 三端点（device_authorization / token 轮询 / refresh）等出站请求上报；
- **telemetry**：`client_version`、`deviceId`、`first_launch`；
- **server_version**：`GET /api/v1/meta`、OpenAPI 文档、会话导出、实例注册表；
- **系统提示词身份**：`${product_name}` / `${reply_style_guide}` 槽位。

### 1.2 乱象清单（均已核实，附证据）

#### A. 值根本没传过去（bug 级）

- **kap-server 链路（web UI、desktop 内嵌 server）的 OAuth 三端点整组 `X-Msh-*` 头缺失**：v2 `OAuthToolkitService` 构造只收 `{ homeDir }`（`agent-core-v2/src/app/auth/authService.ts:864-868`），v1 `ServicesManagedAuthFacade` 同款（`agent-core/src/services/auth/managedAuth.ts:54-65`）；oauth toolkit「无 identity 不带头」（`packages/oauth/src/toolkit.ts:392-399`，有测试断言钉着）。授权服务器看到的不是 `kimi_code_cli`，是**什么都没有**（连 User-Agent 都是 undici 默认值）。
- **v1 core 进程内 token 刷新**（`ServicesManagedAuthFacade`）：同样不带。
- **TUI `-p` v2 实验模式**（`cli/v2/run-v2-print.ts`，用 v2 原生 bootstrap）：同样不带。
- 唯一带头的链路：CLI/TUI 登录（node-sdk `KimiAuthFacade`，`node-sdk/src/auth.ts:103-106`）。

各链路现状：

| 链路 | 登录三端点 | token 刷新 |
|---|---|---|
| CLI / TUI 登录（node-sdk，v1 SDK 路径） | ✅ 全带（`kimi_code_cli`） | ✅ 带 |
| v1 core 进程内刷新 | — | ❌ 全不带 |
| TUI `-p` v2 实验模式 | （不发起登录） | ❌ 全不带 |
| kap-server（web UI、desktop 内嵌） | ❌ 全不带 | ❌ 全不带 |

#### B. 硬编码与兜底谎报

- **`X-Msh-Platform` 硬编码** `kimi_code_cli`（`packages/oauth/src/identity.ts:18`），`KimiHostIdentity` 无 platform 字段。桌面端被迫在 `apps/desktop/src/main/server.ts:52-64` 先 `createKimiDefaultHeaders` 再手动覆写 `headers['X-Msh-Platform']`——且该覆写只 seed 进模型/搜索路径，**够不到 OAuthManager**。
- **kap-server 兜底 UA 谎报**：`User-Agent: kimi-code-cli/${version}`（`kap-server/src/start.ts:240`）——任何非 CLI 宿主没传头时，都顶着 CLI 的产品名出站。
- **bootstrap `clientVersion` 绑死 `version` 选项**（`start.ts:234`），desktop 靠 `bootstrapSeed` 整份覆盖（last-seed-wins）才把 telemetry 上报的版本换成 app 版本——**正确性靠 seed 顺序偶然维持**，kap-server 调整顺序即静默变值。

#### C. 类型与命名不统一

| 层 | 类型/字段 | 实际含义 |
|---|---|---|
| oauth `KimiHostIdentity.userAgentProduct` | 产品 token（`'kimi-code-desktop'`） | transport 身份 |
| kap-server `HostIdentityOverrides.productName` | **展示名**（`'Kimi Code'`，提示词槽位） | 展示身份——与楼上同名不同义 |
| v2 bootstrap `clientVersion` | 宿主产品版本 | 孤立字段，无 product/platform 配套 |
| `ServerStartOptions.version` | **引擎版本**（server_version） | 名字无语义；内部变量 `hostVersion` 同样名不符实 |
| desktop `shared/identity.ts` | `DESKTOP_PRODUCT_NAME / DESKTOP_MSH_PLATFORM / DESKTOP_DISPLAY_NAME` | 值的单一事实源，但类型层不收敛 |

- `userAgentSuffix`：仓根提交（`842e699a6`，2026-05-22）就有的预留字段，至今无生产者（唯一出现是测试里的 `'web-runtime'`）。

#### D. 强行用 seed / 通道错配

- desktop 为改一个 `clientVersion` 字段，用 `bootstrapSeed` **整份替换** `IBootstrapOptions`（顺带把 kap-server 显式传的 `configPath` 丢回默认值，目前恰好解析一致——又一个巧合）。
- desktop 为传身份头必须学习 v2 DI 机制（`hostRequestHeadersSeed`）——一等配置走了扩展通道。
- **deviceId 无单一生产者**：全系统 5 个 `<home>/device_id` 读取/铸造入口（oauth 包原语、CLI telemetry、CLI rollout、desktop、B 之后的 OAuth）。desktop 尤其绕：`server.ts:56-62` 手写 `readKimiDeviceId` 预读算 firstLaunch → `createKimiDefaultHeaders` 内部再铸/读一次 → 从给上游 API 的 headers 字典里**抠** `X-Msh-Device-Id` 给 telemetry，放着 oauth 包的 `onFirstLaunch` 回调不用。

#### E. firstLaunch 语义错误

- **设备级冒充产品级**：desktop `firstLaunch = readKimiDeviceId(homeDir) === null`，而 `~/.kimi-code` 与 CLI 共享——用户跑过一次 CLI，desktop 真首次安装也永不报 `first_launch`。
- **铸造时机与 consent 脱钩**：server 启动即铸 device_id（API 头需要），`wireDesktopTelemetry` 之后才是 consent 检查——consent-off 首启的用户，事件永久丢失。
- CLI 侧存在镜像问题（desktop 先用会吃掉 CLI 的 first_launch）——**留 TODO，本方案不处理**。

### 1.3 `X-Msh-*` 各头取值来源（为什么只需新增 platform 一个入参）

| 头 | 来源 | 需调用方传吗 |
|---|---|---|
| `X-Msh-Platform` | **硬编码** `kimi_code_cli`（identity.ts:18） | 无处可传——唯一要新增的入参 |
| `X-Msh-Version` | 调用方传入的宿主版本（identity.version） | 已在传 |
| `X-Msh-Device-Name` | `os.hostname()` 自动采集 | 不用 |
| `X-Msh-Device-Model` | `deviceModel()` 自动采集（macOS 调 `sw_vers`） | 不用 |
| `X-Msh-Os-Version` | `os.release()` 自动采集 | 不用 |
| `X-Msh-Device-Id` | `createKimiDeviceId(homeDir)`：读 `<home>/device_id`，没有就铸 UUID 写盘（0600） | 不用（homeDir 必传） |

---

## 2. 目标形态

### 2.1 设计原则

1. **一个类型**：`KimiHostIdentity` 从 oauth 包贯穿 toolkit、v1 facade、v2 bootstrap/authService、kap-server option、各宿主，无第二形状；
2. **组合层必填，库层可选**：kap-server option、v2 bootstrap 必填身份（真宿主必须自报家门）；oauth toolkit/OAuthManager 保持可选（库接口，既有测试不动）；
3. **platform 全显式**：每个宿主在自己的 identity 工厂里显式写出，缺省值只当兜底不当契约；
4. **一等配置走类型化参数**：身份是普通配置，不经 seed；seed 只留引擎级扩展（如 `hostRequestHeadersSeed` 的显式覆盖逃生门）；
5. **单源派生**：宿主只出一个 identity 对象，headers / bootstrap 快照 / telemetry / 系统提示词全部由下游从它派生。

### 2.2 统一类型与命名

```ts
// packages/oauth/src/identity.ts —— 唯一身份类型
export interface KimiHostIdentity {
  readonly productName: string;        // ← userAgentProduct 改名；'kimi-code-desktop' | 'kimi-code-cli'
  readonly version: string;            // 宿主产品版本
  readonly platform: string;           // ← 新增且（组合层）显式必填；'kimi_code_desktop' | 'kimi_code_cli'
  readonly userAgentSuffix?: string;   // 保留：UA 括号注释段，预留运行时区分（当前无生产者）
}
```

命名定稿：

| 字段 | 名字 | 语义 |
|---|---|---|
| `KimiHostIdentity.productName` | 产品 token | transport 身份（UA product / client 名） |
| `KimiHostIdentity.version` | 宿主产品版本 | transport 身份 |
| `KimiHostIdentity.platform` | `kimi_code_*` | `X-Msh-Platform` 取值 |
| `KimiHostIdentity.userAgentSuffix?` | UA 括号段 | 预留 |
| `bootstrap.clientIdentity` | 宿主身份（必填） | v2 快照，OAuth/telemetry 消费 |
| `ServerStartOptions.serverVersion?` | 引擎版本（← `version` 改名） | `server_version` 上报 |
| `ServerStartOptions.hostIdentity` | 唯一身份入口（必填） | 见下 |
| `ServerHostIdentity.displayName?` | 展示名（← `HostIdentityOverrides.productName` 改名） | 提示词 `${product_name}` |
| `ServerHostIdentity.replyStyleGuide?` | 回复风格 | 提示词 `${reply_style_guide}` |

```ts
// kap-server —— 对外唯一身份入口
export interface ServerHostIdentity extends KimiHostIdentity {
  readonly displayName?: string;        // 缺省渲染 CLI 文案
  readonly replyStyleGuide?: string;    // 缺省渲染 CLI 文案
}
export interface ServerStartOptions {
  readonly serverVersion?: string;           // 引擎版本；缺省读 kap-server 自身 package.json
  readonly hostIdentity: ServerHostIdentity; // 必填
  // ...其余选项不变
}
```

原 `HostIdentityOverrides` 降级为内部类型 `PromptIdentityOverrides`（仅 displayName / replyStyleGuide）。

### 2.3 各层 after 形态（关键行伪代码）

**oauth 包**

```ts
// identity.ts
createKimiDeviceHeaders({ homeDir, version, platform }): DeviceHeaders
//   'X-Msh-Platform': platform ?? KIMI_CODE_PLATFORM —— 唯一改的行，其余自动采集不动
createKimiUserAgent(identity) // `${productName}/${version}`（+ ` (${userAgentSuffix})`）
createKimiDefaultHeaders({ homeDir, ...identity }) // UA + 设备头，platform 透传

// toolkit.ts:392 —— 闭包透传
deviceHeaders: identity === undefined ? undefined : () =>
  createKimiDeviceHeaders({ homeDir: this.homeDir, version: identity.version, platform: identity.platform }),
```

**agent-core-v2**

```ts
// bootstrap.ts —— clientVersion 删除，唯一身份字段
interface IBootstrapOptions { /* ... */ readonly clientIdentity: KimiHostIdentity }  // 必填

// bootstrapService.ts —— clientVersion accessor 删除，暴露 clientIdentity

// telemetry/cloudAppender.ts —— 版本来源迁移
client_version: bootstrap.clientIdentity.version,
version:        bootstrap.clientIdentity.version,

// auth/authService.ts:864 —— 直接消费，无 undefined 分支（组合层必填）
new KimiOAuthToolkit({ homeDir: bootstrap.homeDir, identity: bootstrap.clientIdentity });
```

**agent-core（v1）**

```ts
// services/auth/managedAuth.ts —— facade 开口（库层，保持可选）
export function createManagedAuthFacade(
  env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
  identity?: KimiHostIdentity,
): ServicesAuthFacade;
// coreProcessService._defaultOAuthTokenResolver / oauthService：沿 coreProcess options.identity 传入
```

**kap-server**

```ts
// start.ts —— version → serverVersion；hostIdentity 必填；headers 自动派生，兜底 UA 删除
bootstrap(
  { homeDir, configPath, clientIdentity: opts.hostIdentity },
  [
    ...logSeed(logging),
    ...hostRequestHeadersSeed(createKimiDefaultHeaders({ homeDir, ...opts.hostIdentity })),
    ...hostIdentitySeed({ displayName: opts.hostIdentity.displayName,
                          replyStyleGuide: opts.hostIdentity.replyStyleGuide }),
    ...(opts.seeds ?? []),   // 显式 seed 仍可覆盖（逃生门）
  ],
);
```

**CLI（apps/kimi-code）**

```ts
// cli/version.ts —— 显式 platform
export function createKimiCodeHostIdentity(version: string): KimiHostIdentity {
  return { productName: CLI_USER_AGENT_PRODUCT, version, platform: KIMI_CODE_PLATFORM };
}
// kimi web 宿主：startServer({ ..., serverVersion: <CLI版本>, hostIdentity: createKimiCodeHostIdentity(version) })
// cli/v2/run-v2-print.ts：bootstrap({ homeDir, clientIdentity: createKimiCodeHostIdentity(version) }, [...])
```

**code-app（desktop）**

```ts
// src/main/identity.ts（新增）—— 单源对象，删掉 headers 抠值与 firstLaunch
export function resolveDesktopHostIdentity(homeDir: string): {
  identity: KimiHostIdentity;  // { productName: 'kimi-code-desktop', version: app.getVersion(), platform: 'kimi_code_desktop' }
  deviceId: string;            // createKimiDeviceId(homeDir) 显式拿
}

// src/main/server.ts —— 零 seed，一处出值
const host = resolveDesktopHostIdentity(homeDir);
await startServer({
  serverVersion: __KIMI_CORE_VERSION__,   // 引擎版本，语义不变
  hostIdentity: {
    ...host.identity,
    displayName: DESKTOP_DISPLAY_NAME,
    replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
  },
});
await wireDesktopTelemetry(handle.core, { deviceId: host.deviceId });

// src/main/ui-state.ts —— first_launch 产品级标记（不做老用户迁移抑制）
interface UiState { /* ... */ firstLaunchReported?: boolean }
// src/main/telemetry.ts
if (shouldReportFirstLaunch()) { telemetry.track2('first_launch'); markFirstLaunchReported(); }
```

**会话导出 manifest 版本语义（kap-server + agent-core-v2）**

```ts
// ExportSessionManifest：
//   kimiCodeVersion = hostIdentity.version（宿主产品版本；desktop 场景即桌面 app 版本）
//   desktopVersion?: string —— 新增，仅 desktop 导出（req.body.desktop === true）时写，
//                     与 includeDesktopLog/desktopLogPath 平行，作为「来自 desktop 宿主」的显式标记
//   引擎版本（serverVersion）不再写入 manifest —— 排障只看宿主版本
// ExportSessionPayload.version 改由路由填 hostIdentity.version（routes/sessionExport.ts:125
// 现取 options.serverVersion）；desktopVersion 与 includeDesktopLog 同一信号填充
```

**A 方案（授权页来源标记，code-app renderer）**

```ts
// src/renderer/lib/loginSource.ts（新增，desktop-only，不同步 web）
withDesktopLoginSource(url) // isDesktop 时 searchParams.set('from', 'kimi_code_desktop')，幂等
// LoginDialog.vue / OnboardingLoginStep.vue（desktop 分叉块）：
//   verificationUriComplete（href/展示/复制）与 verificationUri（fallback）统一走包装后的 computed
```

### 2.4 端到端效果（desktop 一次登录）

1. renderer 打开 `https://<oauth-host>/device?...&from=kimi_code_desktop` → 授权页渲染「打开桌面端」按钮（服务端配合）；
2. daemon 打 `device_authorization`：`User-Agent: kimi-code-desktop/0.0.13` + `X-Msh-Platform: kimi_code_desktop` + 其余五个头；
3. 授权成功点按钮 → `kimi-code://auth/success` → 窗口唤前；
4. telemetry `first_launch` 按 desktop 产品级口径上报；
5. 副产物：`kimi web` 的 OAuth 从此带 CLI 身份头（web 登录链路补上身份，语义正确）。

---

## 3. 实施计划

### 3.1 顺序与依赖

1. **PR #156（deep link 接收侧）**：独立，评审通过后先合并。
2. **kimi-code 仓**（kimi-code-5 克隆）：oauth → v2 → v1 → kap-server → CLI → changesets → PR。
3. **code-app**：identity 收敛 + telemetry/firstLaunch + A 方案 → kimi-code 侧合入后 bump submodule → PR。
4. **服务端协调**（不阻塞客户端开发，阻塞端到端上线）：见 3.5。
5. **CLI first_launch 口径拉齐**：TODO，单独立项。

### 3.2 kimi-code 仓任务分解（按依赖顺序）

| # | 包 | 内容 | 验证 |
|---|---|---|---|
| 1 | `oauth` | `KimiHostIdentity` 加 `platform` 并改名 `userAgentProduct→productName`；`createKimiDeviceHeaders`/`createKimiDefaultHeaders` 透传 platform；`toolkit.ts` 闭包透传 | 既有「无 identity 不带头」测试保持绿；新增 platform 透传/缺省用例；rename 调用点全改 |
| 2 | `agent-core-v2` | `IBootstrapOptions.clientIdentity: KimiHostIdentity` 必填（替换 `clientVersion`）；`bootstrapService`/`cloudAppender`/`authService` 适配；`BootstrapInput`/`resolveBootstrapOptions` 同步；`ExportSessionManifest` 加 `desktopVersion?`（`kimiCodeVersion` 语义随 payload 变为宿主版本） | bootstrap/telemetry/auth/sessionExport 相关测试更新（fixture 身份） |
| 3 | `agent-core`(v1) | `createManagedAuthFacade` 加 `identity?`；两个构造点沿 `coreProcess options.identity` 传入（先核实 `IEnvironmentService` 通道，fallback 从 coreProcessService 注入） | v1 auth/refresh 测试 |
| 4 | `kap-server` | `version→serverVersion`；`hostIdentity: ServerHostIdentity` 必填（合并原 HostIdentityOverrides → 内部 `PromptIdentityOverrides`）；headers 自动派生、删兜底 UA；`bootstrap()` 首参带 clientIdentity；导出路由 `payload.version` 改填 `hostIdentity.version`、`desktop===true` 时填 `desktopVersion` | boot/start/sessionExport 测试补 fixture 身份；调用方全改 |
| 5 | `apps/kimi-code` | `createKimiCodeHostIdentity` 显式 platform；`kimi web` 宿主传 `serverVersion` + `hostIdentity`；`run-v2-print.ts` 首参传 `clientIdentity`；v1 coreProcess identity 随 rename 适配 | CLI 登录 e2e；`-p` v2 模式冒烟 |
| 6 | 全仓 | changesets（oauth / agent-core / agent-core-v2 / kap-server / CLI 相关包，均 patch）；描述写明「kap-server/v1-core/v2-print 链路 OAuth 请求开始携带 X-Msh-* 设备头」与三处 rename | 仓内 CI |

### 3.3 code-app 任务分解

| # | 内容 | 文件 |
|---|---|---|
| 1 | `resolveDesktopHostIdentity` 单源对象 | `apps/desktop/src/main/identity.ts`（新增） |
| 2 | `startDesktopServer` 改类型化参数、删 seed 与手动覆写；`StartDesktopServerOptions.identity` 参数删除（connect.ts 适配） | `apps/desktop/src/main/server.ts`、`connect.ts` |
| 3 | firstLaunch 改 `ui-state.json` 标记；`desktopHostIdentity` 删除 | `apps/desktop/src/main/ui-state.ts`、`telemetry.ts`、`server.ts` |
| 4 | A 方案：`withDesktopLoginSource` + 两组件分叉块 | `apps/desktop/src/renderer/lib/loginSource.ts`（新增）、`LoginDialog.vue`、`OnboardingLoginStep.vue` |
| 5 | 测试：identity/telemetry/ui-state/loginSource 新增与适配 | `apps/desktop/tests/main/*`、`tests/renderer/loginSource.test.ts` |
| 6 | `native-todos.md` 补条目；changeset（`kimi-code-app` patch） | — |
| 7 | kimi-code 合入后 bump submodule 指针 | `kimi-code/` |

### 3.4 测试计划

- kimi-code 仓：相关包 test / lint / typecheck；重点回归 oauth「无 identity 不带头」既有断言（库层语义不变）。
- code-app：`pnpm --filter kimi-code-app exec vitest run`、`pnpm lint`、`pnpm typecheck`。
- 联调（dev）：桌面端起登录，抓 `device_authorization` 请求确认六个头 + `kimi_code_desktop`；renderer 复制链接确认带 `from=`。
- 打包版端到端：A + 授权页上线后，macOS dmg 必验（浏览器确认框 → 唤起），Windows/Linux deb 有条件验。

### 3.5 服务端协调（授权服务团队）

1. 确认 `X-Msh-Platform` 取值无白名单（新增 `kimi_code_desktop`）；kap-server 链路是从「无头」变「有头」（含稳定 `X-Msh-Device-Id` 设备指纹），隐私口径先知会。
2. 授权完成页读 `from=kimi_code_desktop` → 渲染「打开 Kimi Code 桌面端」按钮 → `kimi-code://auth/success`；按钮手动触发；一期不做未安装兜底。
3. 建议同步加 `kimi-code://auth/failure` 对称路径。
4. （可选后续）授权服务器按 flow 记录的 platform 做权威判定。
5. 数据口径知会：desktop `first_launch` 语义改为产品级（上报量上升 + 存量补报）；CLI 维持设备级，desktop-first 设备上 CLI 仍少报（TODO 待拉齐）。

### 3.6 风险与注意

- **行为变化要写明**：B 是「从无到有」（非改值），PR 描述与 changeset 必须显式声明，避免服务端告警/风控误伤。
- **v1 `IEnvironmentService` 的 identity 可得性**是唯一未钉死的点，kimi-code 侧实施第一步先核实（fallback：从 `coreProcessService` 的 `options.identity` 注入）。
- **三处 rename 同批做**（`userAgentProduct→productName`、`HostIdentityOverrides.productName→displayName`、`ServerStartOptions.version→serverVersion`），均 breaking 但限两仓内。
- **对外契约一次定死**：`from` 参数名值、`kimi-code://auth/*` 路径，与授权页团队确认后不再轻动。
