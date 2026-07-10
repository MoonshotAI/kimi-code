# code-app 客户端仓库拆分与桌面端原生化设计

- 日期：2026-07-10
- 状态：草案（待审阅）
- 涉及仓库：`code-app`（新建，客户端仓）、`kimi-code`（核心仓，作为 submodule 被引用）

## 1. 背景

当前 `kimi-code` 是一个 TypeScript monorepo，关键事实：

- `apps/kimi-code`（CLI/TUI）：提供 `kimi` 命令；build 时先 build `apps/kimi-web`、把其 `dist` 拷进 `apps/kimi-code/dist-web`，再经 SEA（Single Executable Application）打成 `dist-native/bin/<target>/kimi`，**SEA 内嵌 web 静态产物**。
- `apps/kimi-web`（Vue 3 + Vite）：浏览器 SPA，经 REST + WebSocket（`/api/v1`）与 server 通信；**对 `@moonshot-ai/*` 零源码依赖**，wire 类型本地重写；默认同源（`window.location.origin`）。
- `apps/kimi-desktop`（Electron 33）：自承「thin shell + process manager」，**零 npm / 零源码依赖** `@moonshot-ai/*`；主进程 `execFile(SEA, ['server','run'])` 启动共享守护进程，读 `~/.kimi-code/server/lock` 拿端口，`BrowserWindow.loadURL(守护 origin)` 套壳 web。无 preload、无 IPC、无本地 renderer、无 webview，主题同步靠 `console-message` hack。
- `packages/server`：已存在可被外部 `import` 的程序化入口 `startServer(opts) → RunningServer`（`src/start.ts:130`），server 包内**不装信号、不阻塞**，唯一 `process.exit` 在 `IServerShutdownService` 默认实现（`start.ts:695`），可由 `serviceOverrides` 中和。阻塞/退出/信号全在 CLI 壳 `apps/kimi-code/.../server/run.ts`。
- 工程化：pnpm workspace（`packages/*`、`apps/*` globs），内部依赖统一 `workspace:^`，各包 `exports → src/*.ts` 直读源码，统一用 `tsdown` 构建；flake.nix 硬编码 `workspacePaths`/`workspaceNames`。

## 2. 目标（三个需求）

1. **拆仓**：把客户端（桌面端）与 web 拆到新仓 `code-app`，`code-app` 引用 `kimi-code` 的代码。
2. **桌面端原生化**：从「web 套壳」改造为原生桌面端；抽出一套组件包与逻辑，主要骨架在桌面端，桌面端 first 开发，web 复用组件。
3. **server 启动改造**：桌面端主进程直接 `import` core/server 代码、调用 `startServer` 启动；服务启动不阻塞桌面端壳子启动。

## 3. 已确认的关键决策

| 主题 | 决策 |
|---|---|
| 仓库归属 | `code-app` = `desktop` + `web` + 共享包；`kimi-code` = CLI + server + core + packages（**删除 `apps/kimi-web` 源码**） |
| 引用方式 | `code-app → kimi-code` 经 **git submodule + 根 pnpm workspace 收编源码**；desktop 只通过 `@moonshot-ai/*` 包名 import，**不散落相对路径**（为将来演进「发私有 npm + 按版本依赖」留接口） |
| web 归属与搬迁 | web 源码**一次性** `git mv` 到 `code-app/apps/web`；kimi-code 仓同步删除 `apps/kimi-web` 并改 SEA 内嵌为消费 `dist-web` 快照 |
| CLI 内嵌 web | `code-app` build web dist → **提交 git 快照**到 `kimi-code/apps/kimi-code/dist-web`（vendoring 模式），SEA build 消费该快照 |
| server 实例 | 桌面端**私有 server**：主进程 `import { startServer }`，home（`~/.kimi-code`）与 CLI 共享、lock 与端口独立，异步启动不阻塞首屏 |
| 原生化节奏 | **分阶段**：先 Electron 壳 + 内嵌 server + `loadURL(copy dist)`；再本地 renderer + IPC；最后仓内抽共享包 |
| 桌面端包名 | 保持 `@moonshot-ai/kimi-desktop` 不改域（降低改动面；后续可再议） |

## 4. 目标仓库形态

```
code-app/                              客户端仓（独立 git repo）
├── kimi-code/                         git submodule，pin 固定 commit/tag
│   ├── packages/{agent-core,server,node-sdk,kosong,kaos,oauth,protocol,...}
│   └── apps/kimi-code/                CLI + SEA；dist-web/ 接收 code-app copy 来的 web 快照
├── apps/
│   ├── desktop/                       桌面端（Electron，由 apps/kimi-desktop 迁来）
│   │   ├── src/main/                  主进程：import @moonshot-ai/server startServer
│   │   ├── src/renderer/              阶段 2 新增本地壳（loadFile）；阶段 0/1 无此目录，主进程 loadURL(origin)
│   │   └── scripts/copy-web-dist.mjs  build 期从 apps/web/dist 拷入
│   └── web/                           web 源码（由 apps/kimi-web 迁来）
├── packages/                          共享包（阶段 3 仓内从 apps/web 拆出）
│   ├── web-ui/                        设计系统 primitives（零业务）
│   ├── web-markdown/                  Markdown 渲染
│   └── web-core/                      api/* + types + lib/* + composables（工厂化）
├── docs/specs/                        设计文档
├── pnpm-workspace.yaml                根 workspace
├── package.json
├── tsconfig.base.json
└── .npmrc
```

## 5. 依赖方向（两条单向，无循环）

- **源码层**：`code-app → kimi-code`。desktop 经 submodule workspace import `@moonshot-ai/server`、`@moonshot-ai/kimi-code-sdk` 等源码；web 仍零 `@moonshot-ai` 依赖、wire 本地重写。`kimi-code` 不 import `code-app` 任何源码。
- **产物层**：`code-app 的 web dist → 手动 copy → kimi-code/apps/kimi-code/dist-web → SEA 内嵌`。是单向产物快照，不进 pnpm workspace，不形成循环。

## 6. 分阶段路线图

每阶段可独立构建/发布/回滚。阶段 0 + 1 落地需求 1 与需求 3；阶段 2 + 3 推进需求 2。

### 阶段 0 · 拆仓地基

**目标**：`code-app` 可 `pnpm install && pnpm dev` 起 Electron 壳；CLI SEA 仍能内嵌 web（来自 dist 快照）。server 此阶段**仍 spawn SEA**，先把壳跑通。

- 仓库与 submodule：`git init code-app`；`git submodule add <kimi-code> kimi-code` pin commit/tag；根脚本 `"sync": "git submodule update --init --recursive"`；CI checkout 配 `submodules: recursive`。
- 根工程化：
  - `package.json`：`private`、`type:module`、`engines.node>=24.15.0`、`packageManager pnpm@10.33.0`，scripts: `sync/dev/build/typecheck`。
  - `pnpm-workspace.yaml` 收编：`apps/*`、`packages/*`、`kimi-code/packages/*`、`kimi-code/apps/kimi-code`；迁 `catalog:{zod}`、`onlyBuiltDependencies:[electron]`、`overrides(ssh2 native)`。
  - `.npmrc`：`engine-strict=true`；`tsconfig.base.json` 复刻 kimi-code 根（`moduleResolution:bundler`、`allowImportingTsExtensions`、`verbatimModuleSyntax`、`isolatedModules`、`strict`、`noEmit`）。
- 迁 `apps/kimi-desktop → apps/desktop`：`tsconfig.json` `extends` 改 `../../tsconfig.base.json`；`sea-path.ts:44`、`before-pack.cjs:27` 的 `../kimi-code/dist-native` 相对路径按新布局改写，或做 `KIMI_SEA_PATH` env 可配置。
- 迁 `apps/kimi-web → apps/web`：源码一次性搬迁；web 零 `@moonshot-ai` 依赖，搬迁最顺。
- **kimi-code 仓改动**：删除 `apps/kimi-web` 源码；改 `apps/kimi-code/package.json` build 脚本、`scripts/copy-web-assets.mjs`、`flake.nix:196`、`.github/workflows/_native-build.yml:89-93` / `desktop-build.yml` 不再 build web，改为消费已存在的 `apps/kimi-code/dist-web` 快照（缺则报错并提示先同步）。
- web dist 同步：新增 `code-app/scripts/sync-web-to-kimi-code.mjs`，`pnpm --filter @moonshot-ai/kimi-web build` 后把 `apps/web/dist` 写入 `kimi-code/apps/kimi-code/dist-web`；在 kimi-code 仓提 PR 提交该快照。

**验证**：`pnpm install`（验嵌套 workspace 无冲突、根 lockfile 生成）→ build web → copy dist → `pnpm --filter @moonshot-ai/kimi-desktop dev` 起 Electron 壳 `loadURL(SEA origin)`；kimi-code 仓 `pnpm --filter @moonshot-ai/kimi-code build:native:sea` 能消费 dist-web 快照出 SEA。

### 阶段 1 · server 内嵌（主进程 import）

**目标**：desktop 不再 spawn SEA，主进程自给自足起私有 server。

- desktop 加依赖：`@moonshot-ai/server`（`workspace:^`，import 源码）、`@moonshot-ai/kimi-code-sdk`（取 `installGlobalProxyDispatcher` 与 identity 工具）。
- 新增 `apps/desktop/src/main/server.ts`，封装 `startDesktopServer()`：
  - `installGlobalProxyDispatcher()`（宿主装代理）。
  - `startServer({ host:'127.0.0.1', port:0, logger, lockPath:'<home>/server-desktop.lock', coreProcessOptions:{ identity }, serviceOverrides:[[IServerShutdownService, { requestShutdown: async () => running.close() }]], webAssetsDir:'<app>/web-dist' })`。
    - `port:0` ephemeral + 独立 `lockPath` → 与 CLI 守护不抢锁；home 不覆盖（共享 session/config 数据）。
    - `identity` 必传（version 取 desktop 版本 + `desktop` 标识），否则上游 40340。
    - `serviceOverrides` 中和 `start.ts:695` 的 `process.exit(0)`（防 `/api/v1/shutdown` 杀主进程）。
  - 返回 `{ origin, port, close }`。
- `index.ts` 主流程：`whenReady()` → 先 `createWindow()` 立即出壳（loading 屏）→ **异步** `startDesktopServer()`（不 `await` 阻塞首屏）→ ready 后 `loadURL(${origin}/?kimi_desktop=1#token=…)` → 失败 `loadURL(dataUrl(errorHtml))`；`before-quit`/`will-quit` → `running.close()`（幂等）；退出**不杀** CLI 守护。
- 原生模块与打包：`node-pty`/`chokidar`（agent-core 传递）经 `@electron/rebuild` + electron-builder `asarUnpack`；server `exports→src/*.ts` + `import.meta.url`/`createRequire`（`svc/program.ts`、`version.ts`）由主进程 tsdown bundle 处理；**去掉 SEA 分发**（`extraResources` 不再需要 `bin/`，mac entitlements 的 `disable-library-validation` 改为给主进程 unpack 的 `.node` 重估）；退役 `ensure-server.ts` 的 `execFile` 路径与 `sea-path.ts`/`before-pack.cjs` 的 SEA 拷贝。

**验证**：桌面端启动 → 主进程起私有 server → renderer `loadURL(私有 origin)` 正常；CLI 守护并行运行互不抢锁；关闭桌面端不杀 CLI 守护。

### 阶段 2 · 本地 renderer 薄壳 + IPC（渲染脱离守护 origin）

**目标**：渲染来源从「守护 origin」改为「本地 file」，server 连接信息由主进程经 IPC 注入；先不抽共享包、不 import kimi-web 源码。

- desktop 增 `src/renderer`（Vite，极薄壳），产物 `out/renderer/index.html`；build 期把 web-dist copy 进 `out/renderer/web`；主进程 `loadFile(out/renderer/index.html)` 替代 `loadURL(origin)`。
- preload + `contextBridge`：`webPreferences` 加 `preload`、`contextIsolation:true`；暴露受控 API：`getServerInfo()` / `setTheme` / `menu` 事件 / `openExternal`，不暴露 node。
- serverInfo 注入：主进程 `startDesktopServer()` 拿到 `{origin,port,token}` → IPC 下发 → renderer 启动写入 `window.__KIMI_SERVER_INFO__`。
- **code-app 仓内改动 web**（web 阶段 0 已归属 code-app，此改动不跨仓）：`apps/web/src/api/config.ts` 的 `defaultServerOrigin` 优先读 `window.__KIMI_SERVER_INFO__`，回退 `location.origin`；`apps/web/src/lib/desktopFlag.ts` 识别「本地 file 模式」。
- 替换 hack：`console-message` 主题同步（`index.ts:196-228`）→ IPC `setTheme`；菜单「重试连接」→ IPC 通知 renderer 重拉 serverInfo；mac 红绿灯/拖拽区（`-webkit-app-region:drag`）对齐原生壳。

**验证**：file:// 本地加载、IPC 注入 serverInfo 后正常连私有 server、主题/菜单 IPC 工作。

### 阶段 3 · 仓内抽共享包 + 原生骨架（web 复用）

**目标**：在 **code-app 仓内** 从 `apps/web` 拆出共享包，web 与 desktop 都 import，全程不跨仓；desktop first 驱动 API。

- 拆包（code-app 仓内）：
  - `packages/web-ui`：`apps/web/src/components/ui/*` + `style.css` tokens + `lib/icons` + `src/icons/kimi`，零业务。
  - `packages/web-markdown`：`chat/Markdown.vue` + `lib/{filePathLinks,markdownPerformance,clipboard}` + 重依赖（markstream-vue/shiki/katex/mermaid + `?worker`），经 `inject('resolveImage')` 解耦。
  - `packages/web-core`：`api/*` + `types.ts` + `lib/*` 纯函数 + composables；关键是 `useKimiWebClient` 模块级单例 `reactive` 改工厂 `createKimiWebClient({storage, i18n, window})`，去掉模块加载期 `window/document/visibilitychange` 全局监听，i18n/storage 参数化（多窗口前提）。
  - `apps/web` 改 import 这三个包（行为不变，靠现有纯逻辑 vitest + 手动回归守住）。
- desktop renderer 切换：从「薄壳 + web-dist」切到「用 `web-ui`/`web-core` 搭原生会话骨架」，first 驱动共享包 API；工厂化 client 后自然支持**多窗口**（每窗口一个 client 实例，连同一私有 server）。
- 暂留 `apps/web`：`chat/Composer.vue`、`ConversationPane`、`Sidebar`、`settings/*`、`mobile/*`、`App.vue`（业务/布局强绑定），按需再抽。

## 7. 跨仓改动清单

- **code-app 仓**：仓库初始化、submodule、根 workspace/tsconfig、迁 `desktop` 与 `web`、`scripts/sync-web-to-kimi-code.mjs` 与 `apps/desktop/scripts/copy-web-dist.mjs`、主进程 `server.ts` + `index.ts` 改造、本地 renderer + preload/IPC（阶段 2）、仓内抽共享包与原生骨架（阶段 3）。
- **kimi-code 仓**（集中在阶段 0，一次性）：删除 `apps/kimi-web` 源码；改 `apps/kimi-code/package.json` build / `scripts/copy-web-assets.mjs` / `flake.nix` / 相关 workflow 不再 build web、改消费 `dist-web` 快照；后续按节奏提交 `dist-web` 快照 PR。其余 `packages/server`、`agent-core`、CLI 启动逻辑 **不动**。

## 8. 风险与待验证

**阶段 0**
- 嵌套 pnpm workspace：理论上根 workspace glob `kimi-code/packages/*` 时，submodule 自带 `pnpm-workspace.yaml` 不生效（pnpm 只在根读），根 lockfile 覆盖。**需 `pnpm install` 实测无冲突**。
- TS 解析：kimi-code 各包 `exports→src/*.ts` + `allowImportingTsExtensions`，需在 code-app `tsconfig.base.json` 复刻后验证 import 解析。
- `onlyBuiltDependencies:[electron]` / `zod:catalog` / `engine-strict(node≥24.15)` 迁移到 code-app 根。
- kimi-code 仓删 web 源码、改消费 dist 快照是不可逆改动，需与 CLI 发版节奏对齐；`flake.nix` 删 `apps/kimi-web` 的 `workspacePaths`/`workspaceNames` 要手工同步（check 脚本只覆盖 kimi-code 闭包，易漏）。

**阶段 1**
- `node-pty`/`chokidar` 在 electron 主进程的 rebuild/asar unpack（需实测）。
- tsdown 主进程 bundle 处理 `import.meta.url`/`createRequire`；`svc`（OS 服务安装）虽用不到但根入口会连带加载，必要时 tree-shake/external。
- `setUnexpectedErrorHandler` 全局单槽（`start.ts:417`）会覆盖 agent-core handler，若 electron 侧也装需注意。
- `startServer` 冷启动含 `await reindex()` + 急切服务实例化，非瞬时——异步起 + loading 屏兜底，不 gate 首屏。
- 两实例同 home 首启时 `server.token` 文件并发写（低风险）。

**阶段 2**
- file:// 加载下 web 产物内资源路径/Worker（mermaid `?worker`）/WebSocket origin 行为需实测。
- `contextBridge` 暴露面最小化，避免泄露 node。

**阶段 3**
- `useKimiWebClient` 解单例改动大、易引入回归；`web-ui` 的 CSS tokens 需与 `web-markdown` 共享；i18n en/zh 双写约束随包走。

## 9. 开放点（Open questions）

1. 桌面端包名是否最终改域（默认保持 `@moonshot-ai/kimi-desktop`）。
2. `dist-web` 快照提交到 kimi-code 仓会积累 dist 历史/体积；需约定清理策略（如只保留在 release 分支 / 定期 squash / 后续改 artifact 下载）。
3. 多窗口支持列为阶段 3 可选项，是否纳入首版桌面端 first 的里程碑。
4. web 产物在 file:// 下的更新/缓存策略（阶段 2 起不再走守护 origin 的版本协商）。

## 10. 不在范围（Non-goals）

- 不重写 server/core 后端；原生化仅窗口壳 + 渲染层，后端契约（REST/WS `/api/v1`）不变。
- 不引入自动更新（桌面端 v1 现状未做，沿用）。
- 阶段 0/1 不抽共享包、不 import kimi-web 源码。
- 不把 kimi-code 的 packages 发到公共 npm；如未来演进「按版本依赖」，再走私有 registry，本设计不实施。
