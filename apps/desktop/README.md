# Kimi Code

Electron 桌面客户端（产品名 **Kimi Code**，workspace 包 `@moonshot-ai/kimi-desktop`）。
主进程在进程内直接启动 Kimi Code server，渲染进程加载一份 web UI 的副本，经自定义协议
`app://renderer` 提供给窗口。它不再 spawn 独立 server 可执行文件（SEA），也不再套壳远
程/共享 daemon 的网页。

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
的 `icons/kimi`，并注入 `__KIMI_WEB_DESKTOP__` / `__KIMI_WEB_VERSION__` / 空的 dev-proxy target）。

关键文件：

- `src/main/index.ts` — 窗口、原生菜单、window-state、loading/error 页、`rendererDistRoot()`、
  `connect()` 串联启动 server 与加载 renderer。
- `src/main/server.ts` — `startDesktopServer`：进程内起 server，写入 CORS allowlist。
- `src/main/protocol.ts` — `app://renderer` scheme/protocol 注册与 `rendererUrl` 拼接。
- `src/main/preload.cjs` — contextIsolation 下的白名单 IPC（主题、菜单/快捷键转发等）。
- `src/renderer/` — web UI 副本（构建源）。
- `vite.renderer.config.ts` — renderer 构建配置。

## 开发

```bash
pnpm run sync          # 初始化/更新 kimi-code submodule（首次或 submodule 变动后）
pnpm install
pnpm dev:desktop       # = build:renderer + tsdown 主进程 + electron .
```

仅改 renderer 时可单独构建：

```bash
pnpm --filter @moonshot-ai/kimi-desktop run build:renderer   # 产物 apps/desktop/desktop-dist/
```

检查：

```bash
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run test
```

## 现状：web 与 desktop 各维护一份

`apps/desktop/src/renderer` 是 `apps/web/src` 在某一刻的快照副本（由提交
`feat(desktop): run full web UI from copied web source in renderer` 引入）。这是**有意为之的
过渡方案**：先让 desktop 跑起完整 web UI，绕开 web 侧与 UI 深度耦合、暂时难以抽出的共享逻
辑，再逐步收敛。代价是 **web 与 desktop 目前各维护一份代码**：

- 改 `apps/web/src` **不会**自动反映到 desktop；改 `apps/desktop/src/renderer` 也不会回写 web。
- 同步目前是手动的：把 `apps/web/src/.` 重新复制到 `apps/desktop/src/renderer/`，并带上
  `apps/web/index.html`。
- 请勿在副本里做 desktop 专属的大改而不回填 web，否则两边会快速分叉。

## 后续计划

按优先级，目前打算：

1. **副本同步机制**：加一个一键脚本（例如 `scripts/sync-web-to-desktop.mjs`）把 `apps/web/src`
   re-copy 到 `apps/desktop/src/renderer`，并校验 `index.html` 入口与 `icons/kimi` 一致；在 CI
   或 pre-commit 里提示副本是否落后于 web。
2. **defines 治理**：`__KIMI_WEB_VERSION__` 现在硬编码为 `'0.1.1-internal.0'`，应改为读
   `apps/desktop/package.json` 的 `version`（与 web 自身一致）。
3. **依赖清理**：`katex` / `shiki` / `mermaid` / `markstream-vue` / `stream-markdown` 等是
   `web-markdown` 的传递依赖，确认是否需要在 `apps/desktop/package.json` 直接列出，可减则减。
4. **临时诊断日志收口**：主进程的 `zoom factor/level/devicePixelRatio` 等 `[kimi-desktop diag]`
   日志在稳定后评估保留或移除。
5. **长期原生化方向**：当前是「web 副本给 desktop 用」的反向过渡。目标是 desktop-first 抽出
   共享组件与逻辑、让 web 复用；前置条件是解开 web 侧 `createAgentProjector` / `toolMeta` 等
   与 UI 的硬耦合。在副本路线跑稳之前不强行抽取。

## 打包

```bash
# 本机未签名构建：
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @moonshot-ai/kimi-desktop run dist
# -> apps/desktop/dist-app/（macOS 上为 dmg + zip）
```

已切换到进程内 server，**不再注入 SEA**。app 的运行时 node_modules 只有 `node-pty`
（tsdown 的 `neverBundle`，经 `asarUnpack` 从 asar 拆出供 `dlopen`）；其余依赖全部在
构建期由 tsdown / vite 打包进 `out/` 与 `desktop-dist/`。因此 `package.json` 的
`dependencies` 只声明 `node-pty`，构建期依赖都在 `devDependencies`——electron-builder
只会把 `dependencies` 闭包拷进 app。

注意：不要重命名构建出的 `.app`，重命名会使签名失效，macOS 会提示「已损坏」。

### CI 打包（GitLab）

根目录 `.gitlab-ci.yml` 提供 4 个手动触发的打包 job（`package:macos-arm64` /
`package:macos-x64` / `package:windows-x64` / `package:linux-x64`），产物只进 GitLab
artifacts（保留 7 天），未做 Release / OSS 分发与自动更新。

- **macOS 签名 + 公证**：默认开启。`apps/desktop/scripts/ci/macos-sign-setup.sh`
  建临时 keychain、导入 Developer ID 证书、自动发现签名身份；`macos-sign-cleanup.sh`
  在 `after_script` 恢复 runner 原有钥匙串状态。需在 GitLab CI/CD Variables 配置
  `APPLE_CERTIFICATE_P12` / `APPLE_CERTIFICATE_PASSWORD` /
  `APPLE_NOTARIZATION_KEY_P8` / `APPLE_NOTARIZATION_KEY_ID` /
  `APPLE_NOTARIZATION_ISSUER_ID`（masked；若配成 protected，注意普通分支拿不到）。
  触发 pipeline 时传 `DESKTOP_SIGN_MACOS=false` 可出未签名包。
- **Windows / Linux**：不签名（Windows 会弹 SmartScreen）。
- runner 需预装 Node >= 24.15.0 与 pnpm 10.33.0；macOS runner 另需 Xcode
  （xcrun / notarytool）。checkout 会自动初始化 kimi-code submodule
  （`GIT_SUBMODULE_STRATEGY: recursive`），runner 需能访问 github.com。

> macOS 未签名出包已实跑验证（dmg/zip、node-pty asarUnpack、desktop-dist 资源均正确）；
> 签名 + 公证链路从原仓 GitHub Actions workflow 逐行翻译，待 GitLab macOS runner
> 首跑验证。

## v1 范围 / 尚未做

- **自动更新**：未实现（v2）。
- **Windows / Linux 签名**：v1 不签名（Windows 会弹 SmartScreen），仅 macOS 计划签名 + 公证。
- **首次启动可能需要联网**：解析原生 sidecar（clipboard / koffi）的方式与已安装 CLI 相同。
