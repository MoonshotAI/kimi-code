# Kimi Code

Electron 桌面客户端（产品名 **Kimi Code**，workspace 包 `kimi-code-app`）。
主进程在进程内直接启动 Kimi Code server，渲染进程加载一份 web UI 的副本，经自定义协议
`app://renderer` 提供给窗口。它不再 spawn 独立 server 可执行文件（SEA），也不再套壳远
程/共享 daemon 的网页。

Windows 使用 40px renderer 自定义标题栏配合 Electron Window Controls Overlay：完整品牌与四个原生菜单入口在左，系统窗口按钮在右；实现集中在 `src/renderer/components/window/WindowsTitleBar.vue`、`src/main/window.ts` 与 `src/main/menu.ts`。

## 当前架构

启动时主进程：

1. 在同一进程里 `startDesktopServer(...)`（直接 import `kimi-code` 的 server 代码，不再 fork
   SEA）。server 监听 loopback 随机端口，返回 `{ origin, token }`。
2. 起 server 时经 `corsOrigins: ['app://renderer']` 选项放行该 origin，让 renderer（`app://renderer`
   origin）能跨域调用 loopback HTTP API；server 端只对 allowlist 内的 origin echo CORS 头。
3. 注册 `app://renderer/<path>` → `desktop-dist/<path>` 的协议映射（带 `..` 越界防护），然后
   `loadURL(rendererUrl(origin, token))`：URL 形如
   `app://renderer/index.html?kimi_desktop=1&kimi_origin=<enc>#token=<enc>`，token 经 hash 注入，
   renderer 启动后用它带 Bearer 调 `/api/v1/*`。

渲染进程：`src/renderer/` 是 `apps/web/src` 的**完整副本**，由 `vite.renderer.config.ts`
构建到 `desktop-dist/`（root = `src/renderer`，outDir = `desktop-dist`，`iconsDir` 指向副本内
的 `icons/kimi`，并注入 `__KIMI_WEB_DESKTOP__` / `__KIMI_CLIENT_VERSION__` / 空的 dev-proxy target）。

关键文件：

- `src/main/index.ts` — 主进程入口，只做引导：先装 `log.ts` 的日志与崩溃守卫，注册
  `app://` 特权 scheme（必须在 `app` ready 前，不能等异步步骤），fire-and-forget 启动
  `shell-env.ts` 的 shell env 探测（GUI 启动只有 launchd 最小 env），最后动态
  `import('./app')`（静态 import 会让整个依赖树先于守卫加载，加载期崩溃无日志）。
- `src/main/app.ts` — 主进程编排：注册 IPC、生命周期事件、`whenReady` 后起窗口。
- `src/main/log.ts` — 主进程文件日志（`~/.kimi-code/logs/kimi-code-desktop.log`，按大小轮转保留
  一个 `.1` 存档）+ `uncaughtException` / `unhandledRejection` 守卫（已知无害的 undici
  流关闭竞态只记日志不弹窗）；`redactUrlForLog()` 负责日志落盘前的 URL 脱敏。renderer 诊断
  经 `kimi:renderer-log` 通道由 `renderer-log.ts` 校验/脱敏/限流后写入同一文件（`[renderer]`
  前缀）；renderer 侧统一入口是 `src/renderer/lib/log.ts`（console 镜像 + 桥转发，web 无桥
  退化为纯 console），`debug/trace.ts` 的 window error/unhandledrejection 也走它落盘。session
  导出时 renderer 带 `desktop: true` 标记，server 自行把该日志文件打进 zip（`logs/kimi-desktop.log`）。
- `src/main/connect.ts` — `connect()` 串联启动 server 与加载 renderer；内嵌 server 启动前
  await shell env 探测结果补全 `process.env`；`rendererDistRoot()`、token 读取、server
  日志路径也在这里。
- `src/main/window.ts` — 窗口创建、window-state 持久化、`sendToRenderer()`。
- `src/main/menu.ts` / `shortcuts.ts` / `screens.ts` — 原生菜单、全局快捷键、启动失败页。
- `src/main/tray.ts` — 系统托盘（macOS 菜单栏 / Windows 通知区）：图标、上下文菜单、待处理
  badge（macOS 菜单栏计数 + 托盘菜单按会话跳转；Windows 的任务栏角标/闪动在 `taskbar.ts`，
  Windows 左键 = 显示主窗口）；主进程原生界面文案的 en/zh 字符串表与 `kimi:locale` 语言
  同步也在这里。macOS 与 Windows 均为关窗 = 隐藏驻留（`window.ts` `shouldHideOnClose`），
  托盘「退出」为显式退出入口；打包版启动有单实例锁，二次启动聚焦已有窗口并路由其 argv。
- `src/main/jump-list.ts` — Windows Jump List（任务栏右键）：「新建会话」task + renderer
  推送的最近工作区（`kimi:jump-list`），条目共用 `--new-chat` / `--workspace="<root>"`
  argv（`parseLaunchArgs`），经 `window.ts` 的 renderer 就绪队列下发 `kimi:launch-action`。
- `src/main/ipc.ts` / `ipc-channels.ts` — IPC handler 注册、channel 常量与 payload 类型。
- `src/main/server.ts` — `startDesktopServer`：进程内起 server，写入 CORS allowlist；`server_version`
  经 tsdown 注入的 `__KIMI_CORE_VERSION__`（`scripts/kimi-core-version.mjs` 读 submodule 的 CLI 版本）
  显式传给 kap-server——bundle 后 kap-server 默认的 package.json 查找会落到 desktop app 自己的版本上。
- `src/main/protocol.ts` — `app://renderer` scheme/protocol 注册与 `rendererUrl` 拼接。
- `src/main/preload.ts` — contextIsolation 下的白名单 IPC（主题、菜单/快捷键转发等）。
- `src/renderer/` — web UI 副本（构建源）。`components/KimiMascot.vue`、`lib/riveInputs.ts`
  与 `assets/mascot/` 是 desktop 专属的小蓝 mascot 组件（原桌宠功能已移除，组件暂未接入
  UI），不属于 web 快照，整目录 re-copy 同步时必须保留（见 `docs/native-todos.md`）。
- `vite.renderer.config.ts` — renderer 构建配置。
- 主进程测试在 `tests/main/`，renderer 测试在 `tests/renderer/`（早期用例仍有与源码同目录的，新测试一律进 `tests/renderer/`）。

## 开发

```bash
pnpm run sync          # 初始化/更新 kimi-code submodule（首次或 submodule 变动后）
pnpm install
pnpm dev:desktop       # = scripts/dev.mjs：vite dev server（renderer HMR）+ tsdown 主进程 + electron .
```

`pnpm dev:desktop` 现在走 `scripts/dev.mjs`：先起 renderer 的 Vite dev server（默认
`http://127.0.0.1:5174`，端口被占会自动顺延），把实际端口经 `KIMI_RENDERER_DEV_URL`
传给 Electron 主进程；主进程（`src/main/connect.ts`）据此改为加载 dev server 而不是
`desktop-dist`，并把该 origin 加进内嵌 server 的 CORS 白名单（HMR 模式下不传
`webAssetsDir`，因为 dev 不再构建 `desktop-dist`）。renderer 改动热更新；主进程改动需重新
`pnpm dev:desktop`。打包/生产行为不变，仍走 `app://renderer` 自定义协议。

生产形态单独构建 renderer：

```bash
pnpm --filter kimi-code-app run build:renderer   # 产物 apps/desktop/desktop-dist/
```

检查：

```bash
pnpm --filter kimi-code-app run typecheck
pnpm --filter kimi-code-app run test
```

## 现状：web 与 desktop 各维护一份

`apps/desktop/src/renderer` 是 `apps/web/src` 在某一刻的快照副本（由提交
`feat(desktop): run full web UI from copied web source in renderer` 引入）。这是**有意为之的
过渡方案**：先让 desktop 跑起完整 web UI，绕开 web 侧与 UI 深度耦合、暂时难以抽出的共享逻
辑，再逐步收敛。代价是 **web 与 desktop 目前各维护一份代码**：

- 改 `apps/web/src` **不会**自动反映到 desktop；改 `apps/desktop/src/renderer` 也不会回写 web。
- 同步目前是手动的：把 `apps/web/src/.` 重新复制到 `apps/desktop/src/renderer/`，并带上
  `apps/web/index.html`。
- **两端逐步分叉是既定方向**：desktop 的原生功能（`window.kimiDesktop` 桥接）只在副本侧
  实现，web 刻意保留旧 daemon 接口实现、不回填；原生路径要带无桥降级。分叉点记录在
  [`docs/native-todos.md`](docs/native-todos.md)，re-copy 同步前先查它，保留 desktop 侧的
  分叉块。两端共有的改动仍按根 AGENTS.md 的顺序回填 web。

## 后续计划

按优先级，目前打算：

1. **副本同步机制**：加一个一键脚本（例如 `scripts/sync-web-to-desktop.mjs`）把 `apps/web/src`
   re-copy 到 `apps/desktop/src/renderer`，并校验 `index.html` 入口与 `icons/kimi` 一致；在 CI
   或 pre-commit 里提示副本是否落后于 web。
2. **依赖清理**：`katex` / `shiki` / `mermaid` / `markstream-vue` / `stream-markdown` 等是
   `web-markdown` 的传递依赖，确认是否需要在 `apps/desktop/package.json` 直接列出，可减则减。
3. **临时诊断日志收口**：主进程的 `zoom factor/level/devicePixelRatio` 等 `[kimi-desktop diag]`
   日志在稳定后评估保留或移除。
4. **长期原生化方向**：当前是「web 副本给 desktop 用」的反向过渡。目标是 desktop-first 抽出
   共享组件与逻辑、让 web 复用；前置条件是解开 web 侧 `createAgentProjector` / `toolMeta` 等
   与 UI 的硬耦合。在副本路线跑稳之前不强行抽取。
5. **原生能力接线**：preload 已暴露的桥接方法大部分闲置，new workspace 目录选择、外链打开、
   系统通知等一批功能可原生化，逐项 TODO 见 [`docs/native-todos.md`](docs/native-todos.md)。

## 打包

```bash
# 本机未签名构建：
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter kimi-code-app run dist
# -> apps/desktop/dist-app/（macOS 上为 dmg + zip）
```

已切换到进程内 server，**不再注入 SEA**。app 的运行时 node_modules 只有 `node-pty`
（tsdown 的 `neverBundle`，经 `asarUnpack` 从 asar 拆出供 `dlopen`）；其余依赖全部在
构建期由 tsdown / vite 打包进 `out/` 与 `desktop-dist/`。因此 `package.json` 的
`dependencies` 只声明 `node-pty`，构建期依赖都在 `devDependencies`——electron-builder
只会把 `dependencies` 闭包拷进 app。

注意：不要重命名构建出的 `.app`，重命名会使签名失效，macOS 会提示「已损坏」。

Windows 使用自定义 40px 全局标题栏和原生 Window Controls Overlay。左侧依次为图标随
主题同向切换（浅色白底、深色深底）的完整品牌、常驻侧栏切换、文件/编辑/视图/帮助菜单及
帮助右侧按状态出现的更新入口；Windows 托盘固定使用带白色背景的完整品牌图标。Sidebar 不重复
品牌、切换或更新控件，并省略原品牌 Header，收起后也不显示浮动展开或新建会话按钮。

### CI 打包（GitHub Actions）

根目录 `.github/workflows/desktop-build.yml` 提供手动触发的打包流水线
（Actions -> desktop-build -> Run workflow），matrix 并发出 macOS arm64/x64、
Windows x64、Linux x64 四个平台的安装包，产物以 `kimi-code-app-<target>`
命名进 artifacts（默认保留 7 天，可用 `retention-days` 输入调整）。
发版走 `.github/workflows/release.yml`（changeset + GitHub Release，见
`.changeset/README.md`），会复用本 workflow 打出签名包并挂为 release
assets；未做 OSS 分发与自动更新。

- **macOS 签名 + 公证**：默认开启。`.github/actions/macos-keychain-setup`
  composite action 建临时 keychain、导入 Developer ID 证书、自动发现签名身份；
  `macos-keychain-cleanup` 在 job 末尾（`if: always()`）删除临时 keychain。
  需在 repo Settings -> Secrets and variables -> Actions 配置
  `APPLE_CERTIFICATE_P12` / `APPLE_CERTIFICATE_PASSWORD` /
  `APPLE_NOTARIZATION_KEY_P8` / `APPLE_NOTARIZATION_KEY_ID` /
  `APPLE_NOTARIZATION_ISSUER_ID`。Run workflow 时把 `sign-macos` 设为
  false 可出未签名包。
- **Windows / Linux**：不签名（Windows 会弹 SmartScreen）。
- 使用 GitHub 标配 runner（`macos-15` / `macos-15-intel` / `windows-2025` /
  `ubuntu-24.04`），checkout 带 `submodules: recursive` 自动初始化 kimi-code
  submodule，Node/pnpm 由 setup actions 按仓内版本要求安装。

> 四平台打包（含 macOS 签名 + 公证）已在本仓首跑验证通过。

### 本地签名打包（CI 不可用时）

```bash
pnpm package:macos   # = bash apps/desktop/scripts/package-local-macos.sh
```

`scripts/package-local-macos.sh` 复用 `scripts/ci/macos-sign-setup.sh` /
`macos-sign-cleanup.sh`（与 CI 的 composite action 同一套临时 keychain + 身份发现 +
公证逻辑），只出 arm64 的 dmg + zip；本地没有 CI 的收尾步骤，脚本用 `trap` 保证任何
退出路径都执行 cleanup 恢复钥匙串。出包后自动做 `codesign --verify --deep --strict`、
`spctl -a -vv`、`xcrun stapler validate` 三项验证。

凭证与 CI 的 5 个变量同名，三种给法（都支持文件形式转 base64，详见脚本头注释）：

```bash
# 方式一：仓库根 .env（脚本自动加载；复制 .env.example 为 .env 填值即可，
# .env 已被 .gitignore 忽略，不会进 git）
cp .env.example .env && $EDITOR .env

# 方式二：与 CI 相同的 base64 环境变量
export APPLE_CERTIFICATE_P12=...        # base64 的 Developer ID Application .p12
export APPLE_CERTIFICATE_PASSWORD=...   # .p12 密码（缺省时脚本交互式询问）
export APPLE_NOTARIZATION_KEY_P8=...    # base64 的 App Store Connect API Key
export APPLE_NOTARIZATION_KEY_ID=...
export APPLE_NOTARIZATION_ISSUER_ID=...

# 方式三：直接给文件路径，脚本内部转 base64
export APPLE_CERTIFICATE_P12_FILE=/path/to/developer-id.p12
export APPLE_NOTARIZATION_KEY_P8_FILE=/path/to/AuthKey_XXXXXXXX.p8
# KEY_ID / ISSUER_ID 仍需 env 提供
```

## v1 范围 / 尚未做

- **自动更新**：未实现（v2）。
- **Windows / Linux 签名**：v1 不签名（Windows 会弹 SmartScreen），仅 macOS 计划签名 + 公证。
- **首次启动可能需要联网**：解析原生 sidecar（clipboard / koffi）的方式与已安装 CLI 相同。
