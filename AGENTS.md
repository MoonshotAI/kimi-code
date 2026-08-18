# Repository-level Agent Guide

中文回复用户。本文件是 code-app 仓的 hot-path 规则唯一正本；结构 / 约束 / 命令变化时只更新本文件，`README.md` 只引用不复制。

## 仓库定位与现状

- `code-app` 是 Kimi Code 的客户端仓，也是 **Web UI（`apps/web`）和桌面端（`apps/desktop`）源码的主仓库**。CLI / TUI / server / agent 在核心仓 `kimi-code`，以 git submodule 引入（`kimi-code/`，跟踪 `main`），不在本仓开发。
- web 产物经 `scripts/sync-web-to-kimi-code.mjs` 同步到 kimi-code checkout 的 `apps/kimi-code/dist-web`。

## 硬约束

- **依赖方向 `code-app → kimi-code` 单向**：desktop 只经 `@moonshot-ai/*` 包名 import kimi-code 的 packages 源码，禁止跨包相对路径 import；`kimi-code` 不得 import `code-app`。
- `apps/web` 只依赖 `@moonshot-ai/{app-core,app-i18n,app-markdown,app-ui,app-client,app-composer}` 共享包，不直接 import kimi-code 的包。
- **不改包名**：`kimi-code-web`、`kimi-code-app`。
- **两端逐步分叉是既定方向**：desktop 的原生功能（`window.kimiDesktop` 桥接）只在 `apps/desktop` 实现，web 保留原 daemon 实现、不回填；原生路径必须带无桥降级（探测不到桥时回退旧实现）。分叉清单在 `apps/desktop/docs/native-todos.md`——改两端共有的文件前先查它，手动同步副本时保留 desktop 侧的分叉块。
- **开发顺序**：两端共有的 UI 改动优先在 `apps/desktop` 开发，完成后再同步到 `apps/web`（desktop 专属原生功能除外，见上条）。
- **UI 改动必须遵循设计系统**：改组件 / 样式 / 布局 / 主题前，先读 canonical 设计规范 `apps/desktop/src/renderer/views/DesignSystemView.vue`（与 `apps/web` 同步；应用内长按侧栏 logo 打开）。新增 / 修改的 UI 必须与之匹配；涉及结构、约束或新组件模式时，同步更新该文档。组件原语（`@moonshot-ai/app-ui`）的结构性例外只有两个：(1) dock 工作面板行/卡片上的全覆盖隐形打开层（`TasksPane` 的 `.tp-open`、`SubagentGrid` 的 `.sg-open`）用原生 `<button>` 而非 Button 原语——它是无标签、无尺寸、无变体外观的纯交互层，Button 的 chrome 与 `:active` scale 不适用；(2) mention pill 的悬停 tooltip（`packages/app-composer` 的 `mentionTooltip`）——document 级裸 DOM 单例，锚点是 ProseMirror NodeView 和 pillify 后的 span，Vue 原语（Button/IconButton）够不到，其 open/copy 按钮按 Button 契约（尺寸、hover、`:focus-visible` 环）手工复刻，DesignSystemView 的 mention 段已备案。
- **样式只用 token，且必须视觉验证**：颜色 / 字体 / 圆角 / 间距 / 阴影 / z-index / 动效一律取 `style.css` 的 CSS 变量（`--color-*` / `--radius-*` / `--space-*` / `--text-*` / `--font-*` / `--z-*` / `--shadow-*` / `--ease-*` / `--duration-*` 等），禁止手写 ad-hoc 值。UI 改动必须在亮色 + 暗色下验证 hover/focus 等状态，构建 / typecheck / lint 通过不算完成；`pnpm --filter kimi-code-web run check:style` 守 §06 反模式，改动文件不得新增 findings。
- **主进程原生界面的文案必须双语（en/zh）**：主进程没有 i18n runtime，新增用户可见字符串（托盘 / 通知 / 对话框等）禁止单语言硬编码——走 `apps/desktop/src/main/tray.ts` 的字符串表模式（措辞与计数无关，规避复数规则）；语言由 renderer 经 `kimi:locale` 通道推送（应用内语言优先，未推送前按 OS 语言兜底），切换语言要带当前状态重渲染。
- **不在本仓直接改 `kimi-code/` submodule 的内容**；kimi-code 侧改动在你的工作克隆里做（见"双仓工作流"），本仓只 bump submodule 指针。
- **提交规范**：Conventional Commits；禁止任何 `Co-Authored-By` 署名；commit message、PR、代码、文档不得出现 agent / AI 工具的名称或身份信息。PR 描述用英文。
- **changeset 必走 skill**：提交 PR 前必须运行 `changeset` skill（`.agents/skills/changeset/SKILL.md`）并按其规则在 `.changeset/` 生成 changeset；纯测试 / 重构 / 文档等无用户可见变化的改动除外。**一律 `patch`**；认为需要 `minor` / `major` 时必须先向用户说明并获得明确同意，否则仍写 `patch`。**只写 `kimi-code-app`**：release CI 不 checkout submodule，`pnpm changeset` 列表里严禁选 submodule 的包，选错 release CI 直接挂。
- **stage 用显式路径，不用 `git add -A` / `git add .`**：本仓有构建产物目录（如 desktop 的 `desktop-dist`），gitignore 变动会让它们突然"显形"被误扫进 commit。
- Node `>=24.15.0`，pnpm `10.33.0`（`.npmrc` 设 `engine-strict=true`，Node 不符装不上依赖）。

## 目录地图

- `apps/desktop`：Electron 壳（`kimi-code-app`）；简介见 `apps/desktop/README.md`，原生功能分叉清单见 `apps/desktop/docs/native-todos.md`。新测试：主进程进 `tests/main/`，renderer 进 `tests/renderer/`。
- `apps/web`：浏览器 Web UI（`kimi-code-web`，Vue 3 + Vite + vue-i18n）。dev 时 Vite 把 `/api/v1`（REST + WS）代理到 `KIMI_SERVER_URL`（默认 `http://127.0.0.1:58627`）。
- `apps/auth-login`：Remote Control 鉴权中间页（`kimi-code-auth-login`，单页、移动端优先）：OAuth device flow 经 `@moonshot-ai/kimi-code-oauth/device` 直连 auth.kimi.com（CORS 直连，无 dev proxy），token 写 `kimi-auth` cookie；`redirect_uri` 可选，有则登录后回跳。方案见 `docs/plans/2026-08-13-rc-auth-login.md`。
- `packages/*`：`@moonshot-ai/{app-core,app-i18n,app-markdown,app-ui,app-client,app-composer}` + `vite-preset`（exports→src，被 apps/web 与 desktop renderer 复用）——app-core 是无 Vue 依赖的纯层（api 客户端 / lib 纯函数 / client 渲染类型与热路径纯模块），app-client 是 Vue 客户端层：composables（注入 api / t / tracker）+ client 单例（`client/`，注入缝 `setKimiClientDeps`）+ Pinia domain stores（`stores/`，包持有 `clientPinia` 实例，两端 main.ts 安装；规范见 `docs/specs/2026-08-01-renderer-architecture.md` §5），app-composer 是 composer 富文本层（wire codec / ProseMirror editor / 用户消息渲染器 ComposerText / mention DOM）；共享字体产物在 `app-ui/src/assets/fonts`（gitignored），由 `scripts/prepare-fonts.mjs` 自动准备。
- `kimi-code/`：git submodule（核心仓）。`kimi-code/packages/*` 提供 `kap-server`、`agent-core-v2`、`kimi-code-sdk` 等源码。
- `scripts/sync-web-to-kimi-code.mjs`：`apps/web/dist` → `<kimi-code checkout>/apps/kimi-code/dist-web`（`KIMI_CODE_REPO` 必传，指定目标 checkout）。
- `KIMI CODE LOGO/` + `scripts/build-brand-icons.mjs`：品牌源文件与 desktop 图标资源的生成脚本（`pnpm build:icons`）；`apps/desktop/build/` 的图标与 desktop 组件内联品牌标是产物，勿手改。**web 品牌已分叉**：`apps/web` 的侧栏 / onboarding / favicon 用回旧版小蓝标，不由该脚本生成（脚本刻意不再写 apps/web），勿用机器人标冲掉。
- `publish-desktop-cdn.sh`：desktop 产物的 CDN 发布（GH Release → TOS 双链路 + 切 latest*.yml 指针 + 刷新 `download/` 入口），本地手动，TOS 凭证限内网；完整流程见根 `README.md` 发布节。
- `.github/workflows/`：`desktop-build.yml` 打四平台安装包（macOS 签名 secrets 等见文件头注释）；`release.yml` 驱动 changeset 发版（不发 npm），细节见 `.changeset/README.md`。

## 常用命令

```bash
pnpm run sync      # git submodule update --init --recursive
pnpm install       # 装依赖（首次或 workspace 变动后；postinstall 会准备共享字体）
pnpm build:icons   # 从 KIMI CODE LOGO/ 品牌源文件重新生成 desktop 图标资源（apps/desktop/build/ + desktop 组件内联品牌标；web 已分叉回小蓝，不在输出内）
pnpm dev:desktop   # 桌面端（renderer HMR + 默认启动内嵌 server）
pnpm dev:desktop:debug  # 桌面端，并开启 Electron remote debugging（端口 9222，供 agent-browser 连接）
pnpm dev:web       # Web UI（Vite，代理到 127.0.0.1:58627）
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop  # 外部 server 模式（不起内嵌 server）
pnpm run sync:web  # 同步 web dist 到 kimi-code checkout（先 build web）
pnpm package:macos # 本地打包并签名 macOS arm64 包（CI 不可用时的替代，凭证见 apps/desktop/scripts/package-local-macos.sh 头注释）
pnpm test          # 根 vitest
pnpm lint          # oxlint --type-aware（.oxlintrc.json 排除 kimi-code submodule——上游代码由上游 CI lint）
pnpm typecheck     # desktop + web
pnpm build         # pnpm -r run build
```

## 双仓工作流

- **kimi-code 侧改动（CLI / server / core）**：在你的 kimi-code 工作克隆里改并启动 server；code-app 用 `KIMI_SERVER_URL` 指过去联调（不启动内嵌 server，不用动 submodule）：

  ```bash
  # 1. kimi-code 克隆里启动 server（KIMI_CODE_CORS_ORIGINS 仅 desktop 需要——
  #    app://renderer 是生产 origin，http://127.0.0.1:5174 是 dev HMR 的
  #    Vite dev server origin，端口被占会顺延，以 dev 启动日志为准；
  #    web dev server 走同源代理，不需要 CORS）：
  KIMI_CODE_CORS_ORIGINS="app://renderer,http://127.0.0.1:5174" pnpm dev:server

  # 2a. desktop 指向该 server（不会启动内嵌 server）：
  KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop

  # 2b. 或者 web 指向该 server：
  KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web
  ```

  Token 通过 `KIMI_CODE_HOME` 共享：两边默认 `~/.kimi-code`，desktop 读到的正是外部 server 写入的 token 文件；server 用自定义 `KIMI_CODE_HOME` 启动时，`pnpm dev:desktop` 要传同一个。外部 server 使用 CLI 的 host 身份（不是 `kimi-desktop`），开发场景没有影响。不带 `KIMI_SERVER_URL` 时 `pnpm dev:desktop` 保持内嵌 server 行为。
- **bump submodule**：工作克隆推了新 commit 后，在 `kimi-code/` 里 `git fetch origin <branch> && git checkout <commit>`，回本仓根目录 `git add kimi-code && git commit -m "chore: bump kimi-code submodule"`。
- **web 改动同步**：`pnpm --filter kimi-code-web run build` → `KIMI_CODE_REPO=<kimi-code checkout> pnpm run sync:web`。要给 kimi-code 提 dist PR（含 changeset 衔接核对）时走 `sync-web-dist` skill（`.agents/skills/sync-web-dist/SKILL.md`）。
