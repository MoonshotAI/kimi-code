# Repository-level Agent Guide

中文回复用户。本文件是 code-app 仓的 hot-path 规则；改了结构 / 约束 / 命令要同步更新本文件与 `README.md`。

## 仓库定位与现状

- `code-app` 是 Kimi Code 的客户端仓，也是 **Web UI（`apps/web`）和桌面端（`apps/desktop`）源码的主仓库**。CLI / TUI / server / agent 在核心仓 `kimi-code`，以 git submodule 引入（`kimi-code/`，跟踪 `main`），不在本仓开发。
- web 产物经 `scripts/sync-web-to-kimi-code.mjs` 同步到 kimi-code checkout 的 `apps/kimi-code/dist-web`。
- 背景详见 `README.md`。

## 硬约束

- **依赖方向 `code-app → kimi-code` 单向**：desktop 只经 `@moonshot-ai/*` 包名 import kimi-code 的 packages 源码，禁止跨包相对路径 import；`kimi-code` 不得 import `code-app`。
- `apps/web` 只依赖 `@moonshot-ai/{web-core,web-i18n,web-markdown,web-ui}` 共享包，不直接 import kimi-code 的包。
- **不改包名**：`kimi-code-web`、`kimi-code-app`（两端原名 `@moonshot-ai/kimi-web` / `@moonshot-ai/kimi-desktop`，2026-07 更名）。
- **两端逐步分叉是既定方向**：desktop 的原生功能（经 `window.kimiDesktop` 桥接，如原生目录选择器）只在 `apps/desktop` 实现；web 刻意保留原有 daemon 接口实现，不回填。原生路径必须带无桥降级（探测不到桥时回退旧实现）。已分叉的功能点记录在 `apps/desktop/docs/native-todos.md`；改两端共有的文件前先查它，手动同步副本时保留 desktop 侧的分叉块。
- **开发顺序**：两端共有的 UI 改动优先在 `apps/desktop` 开发，开发完成后再同步到 `apps/web`（desktop 专属原生功能除外，见上条）。
- **UI 改动必须遵循设计系统**：改组件 / 样式 / 布局 / 主题前，先读 canonical 设计规范 `apps/desktop/src/renderer/views/DesignSystemView.vue`（与 `apps/web` 同步；应用内长按侧栏 logo 打开）。新增 / 修改的 UI 必须与之匹配；涉及结构、约束或新组件模式时，同步更新该文档。
- **样式只用 token，且必须视觉验证**：颜色 / 字体 / 圆角 / 间距 / 阴影 / z-index / 动效一律取 `style.css` 的 CSS 变量（`--color-*` / `--radius-*` / `--space-*` / `--text-*` / `--font-*` / `--z-*` / `--shadow-*` / `--ease-*` / `--duration-*` / `--weight-*` / `--leading-*` 及少量 `--p-*` / `--anim-*`），禁止手写 ad-hoc 值。UI 改动必须在亮色 + 暗色下验证 hover/focus 等状态，构建 / typecheck / lint 通过不算完成；`pnpm --filter kimi-code-web run check:style` 守 §06 反模式，改动文件不得新增 findings。
- **主进程原生界面的文案必须双语（en/zh）**：主进程没有 i18n runtime，新增用户可见字符串（托盘菜单 / tooltip、通知、对话框等）禁止单语言硬编码——走 `apps/desktop/src/main/tray.ts` 的字符串表模式（措辞与计数无关，规避复数规则）；语言由 renderer 经 `kimi:locale` 通道推送（应用内语言优先，未推送前按 OS 语言兜底），切换语言要带当前状态重渲染。
- **Windows 标题栏是 desktop-only 分叉**：`WindowsTitleBar.vue` 只在 win32 desktop 渲染，主进程用 Window Controls Overlay 保留原生三键；完整品牌的图标与主题同向（浅色白底、深色深底），其右侧依次放常驻侧栏切换按钮、菜单入口与帮助右侧按状态出现的更新 pill，菜单入口只能经白名单 `kimi:menu-popup` 弹 `menu.ts` 的同一份原生 submenu，禁止在 renderer 复制菜单业务。Windows 托盘固定使用带白色背景的完整品牌图标。Sidebar 在 Windows 不渲染品牌 Header，不承载品牌、切换或更新入口，折叠态不渲染浮动展开/新建会话按钮。
- **注释克制，密度对齐所在文件**：不写复述代码的注释（`/* 分隔线 */` 这类给自解释代码贴标签的），注释密度不得超过周边既有代码；设计决策、bug 根因、调研结论写进 spec / commit message，不进代码。注释语言跟随所在文件惯例（本仓代码基本是英文）。（2026-07 composer 工作区选择器一次加了 20+ 行注释、含整段根因分析，被打回清理。）
- **不在本仓直接改 `kimi-code/` submodule 的内容**；kimi-code 侧改动在你的工作克隆里做（见"双仓工作流"），本仓只 bump submodule 指针。
- **提交规范**：Conventional Commits；禁止任何 `Co-Authored-By` 署名；commit message、PR、代码、文档不得出现 agent / AI 工具的名称或身份信息。PR 描述用英文。
- **changeset 必走 skill**：每次任务完成、提交 PR 前，必须运行 `changeset` skill（`.agents/skills/changeset/SKILL.md`）并按其规则在 `.changeset/` 生成 changeset；纯测试 / 重构 / 文档等无用户可见变化的改动除外。**早期阶段一律 `patch`**；认为需要 `minor` / `major` 时必须先向用户说明并获得明确同意，否则仍写 `patch`。**changeset 只写 `kimi-code-app`**：kimi-code submodule 的包不在 ignore 防护内（release CI 不 checkout submodule，ignore 无法引用不存在的包），`pnpm changeset` 列表里严禁选择，选错 release CI 直接挂。
- **不擅自启动 agent-browser 调试**：未经用户明确要求，不得自行运行 `pnpm dev:desktop:debug`、连接 `agent-browser` 或操作桌面端 UI；确有需要先向用户说明并获同意。
- **stage 用显式路径，不用 `git add -A` / `git add .`**：本仓有构建产物目录（如 desktop 的 `desktop-dist`、已清理的 `web-dist`），gitignore 变动会让它们突然"显形"，`git add -A` 会误扫进 commit（2026-07 实际出过一次）。
- Node `>=24.15.0`，pnpm `10.33.0`（`.npmrc` 设 `engine-strict=true`，Node 不符装不上依赖）。

## 目录地图

- `apps/desktop`：Electron 壳（`kimi-code-app`）。`src/main/index.ts` 主进程入口（只做引导：先装 `log.ts` 的文件日志 + 崩溃守卫——写 `~/.kimi-code/logs/kimi-code-desktop.log`——注册 `app://` 特权 scheme（必须赶在 app ready 前）——fire-and-forget 启动 `shell-env.ts` 的 shell env 探测，最后动态加载 `app.ts`；GUI 启动只有 launchd 的最小 env，探测用 `$SHELL -lic` 跑 Electron 二进制的 JSON env 转储（`ELECTRON_RUN_AS_NODE`，不依赖系统 node），`connect.ts` 在 `startDesktopServer` 前 await 探测把用户 shell 环境填进 `process.env`——fill-missing，PATH 只追加缺失的绝对路径条目，`KIMI_*` 与终端噪音变量有 denylist，10s 超时 SIGKILL 整个进程组，失败静默降级并写日志，`KIMI_DESKTOP_NO_SHELL_ENV` 可关闭——内嵌 server 及其 spawn 的工具才能看到 Homebrew / token 等；renderer 诊断经 `kimi:renderer-log` 通道由 `renderer-log.ts` 校验/脱敏/限流后写入同一文件（`[renderer]` 前缀），renderer 侧统一入口 `src/renderer/lib/log.ts`（console 镜像 + 桥转发，web 无桥退化为纯 console）；session 导出带 `desktop: true` 标记时 server 会自行把该日志文件打进 zip（`logs/kimi-desktop.log`）；编排在 `app.ts`：窗口 `window.ts`、菜单 `menu.ts`（含 App 菜单「设置…」项，accelerator 跟随 renderer 经 `kimi:menu-shortcut` 推送的用户绑定；编辑菜单不用 editMenu 角色而是手工拼装——原生 Select All 角色的加速键会先于 renderer 截获按键并整页选中，自定义「全选」项保留加速键、经 `kimi:menu-action` 转发 renderer 的作用域全选）、快捷键 `shortcuts.ts`、系统托盘 `tray.ts`（Windows 侧左键显示窗口，待办的任务栏角标/闪动在 `taskbar.ts`）、Windows Jump List `jump-list.ts`（工作区条目推送 + `--workspace`/`--new-chat` argv 解析路由）、IPC `ipc.ts` + channel 常量 `ipc-channels.ts`、文本框原生右键菜单 `context-menu.ts`（`webContents` 的 `context-menu` 事件对 `isEditable` 弹原生编辑菜单，覆盖搜索框/composer/内联重命名；macOS 带 Look Up，全条目显式双语 label，`window.ts` 安装，见 `apps/desktop/docs/native-todos.md`）、server 连接 `connect.ts`、启动失败页 `screens.ts`、自动更新 `updater.ts`（electron-updater generic feed 轮询 `https://code.kimi.com/kimi-code/desktop/` 的 latest*.yml，状态经 `kimi:update-status` 推给 renderer 的 UpdateIndicator——侧栏 header 最右端黄 pill + §09 规范弹窗；dev 未打包时整体 no-op）；dev 下手动把 Dock 图标设为 `build/icon.png`，打包态由 electron-builder 处理）；`src/main/server.ts` 内嵌 server（`startDesktopServer`：回环 + 临时端口 + 注册进 `<home>/server/instances/` 实例表；免 bearer 鉴权（`disableAuth`——唯一客户端是自家 renderer，`/api/v1/meta` 带 `dangerous_bypass_auth` 让 renderer 跳过鉴权弹窗），外部 server 模式（`KIMI_SERVER_URL`）仍读 `<home>/server.token` 经 `#token=` 注入；`server_version` 传 tsdown 注入的 `__KIMI_CORE_VERSION__`，即 submodule CLI 版本，见 `apps/desktop/scripts/kimi-core-version.mjs`）；`telemetry.ts` 在 server 启动后经 `handle.core` 装 agent-core-v2 的 CloudAppender（consent 读 config `telemetry` 键 + `KIMI_DISABLE_TELEMETRY`，仅内嵌模式）；宿主事件契约本地定义在 `telemetry-events.ts`（renderer 可发事件的契约在 `src/shared/track-events.ts`，renderer 编译期直连；刻意不进 kimi-code 公开注册表——app 未发布防产品面泄漏，wire 格式一致可日后迁移），主进程经 `track.ts` 的 `trackDesktopEvent`、renderer 经 `kimi:track` 通道（白名单逐字段校验）汇入同一管线）；`system-metrics.ts` 周期采样 `system_metrics`（consent 门内由 `telemetry.ts` 启停：主进程含内嵌 server 的内存/CPU + `getAppMetrics` 子进程聚合 + 注入读 renderer JS 堆，字段口径对齐 CLI v1 collector）；`src/main/connect-target.ts` 外部 server 模式解析（`KIMI_SERVER_URL`，纯函数）；`src/main/protocol.ts` `app://renderer` 协议映射（带 `..` 越界防护）；`src/main/trace.ts` Help 菜单「性能录制」（`contentTracing` 环形缓冲录全进程 Chromium trace，停止时弹保存框落盘 JSON，ui.perfetto.dev 可分析）。`pnpm dev` 走 `scripts/dev.mjs`：起 renderer 的 Vite dev server（默认 `http://127.0.0.1:5174`）并把实际端口经 `KIMI_RENDERER_DEV_URL` 传给主进程，`connect.ts` 据此加载 dev server（renderer HMR）并把该 origin 加进内嵌 server 的 CORS 白名单；主进程改动需重启 dev。主进程测试在 `tests/main/`，renderer 测试在 `tests/renderer/`（DOM composable 等；早期用例仍有与源码同目录的，新测试一律进 `tests/renderer/`）。自定义键盘快捷键为 desktop-only：`src/renderer/lib/keymap.ts`（action 注册表 + 绑定原语）+ `src/renderer/composables/useShortcuts.ts`（localStorage 覆盖表 `kimi-web.shortcut-overrides`）+ `App.vue` 全局 dispatcher + 设置页 `components/settings/ShortcutsPanel.vue`；web 保持硬编码键位，分叉清单见 `apps/desktop/docs/native-todos.md`。细则见 `apps/desktop/README.md`。
- `apps/web`：浏览器 Web UI（`kimi-code-web`，Vue 3 + Vite + vue-i18n）。dev 时 Vite 把 `/api/v1`（REST + WS）代理到 `KIMI_SERVER_URL`（默认 `http://127.0.0.1:58627`）。
- `packages/*`：`@moonshot-ai/{web-core,web-i18n,web-markdown,web-ui}` + `vite-preset`（exports→src，被 apps/web 与 desktop renderer 复用）；`web-ui/src/assets/fonts` 保存字体许可证与本地生成（gitignored）的两端共用字体产物，install 的 root postinstall 以及 dev/build 前会由 `scripts/prepare-fonts.mjs` 下载、校验并转换，再由 Vite 打入最终产物。
- `kimi-code/`：git submodule（核心仓）。`kimi-code/packages/*` 提供 `kap-server`、`agent-core-v2`、`kimi-code-sdk` 等源码。
- `scripts/sync-web-to-kimi-code.mjs`：`apps/web/dist` → `<kimi-code checkout>/apps/kimi-code/dist-web`（`KIMI_CODE_REPO` 必传，指定目标 checkout）。
- `KIMI CODE LOGO/` + `scripts/build-brand-icons.mjs`：设计师交付的品牌源文件（SVG/PNG，整目录替换）与下游图标资源生成脚本（`pnpm build:icons`，几何约定见脚本头注释）；`apps/desktop/build/` 的图标与组件内联品牌标都是它的产物，勿手改。可选的 `apps/desktop/build/AppIcon.icon` 是 Icon Composer 手工艺品（一次性设计步骤，Xcode 26）：存在时打包经 afterPack 自动编译为 Assets.car，启用 Tahoe 深色/玻璃外观（`.icns` 保留作旧系统兜底，见 `electron-builder.config.cjs`）。
- `scripts/merge-mac-update-yml.mjs`：把 mac 双 arch 的 `latest-mac-<arch>.yml` 合并回单个 `latest-mac.yml`（files 含双 arch；release.yml 发布前调用，零第三方依赖的文本级合并）。根目录另有 `publish-desktop-cdn.sh`：desktop 产物的 CDN 发布（GH Release → TOS 版本目录 + 更新弹窗双语 changelog（`release-notes/<version>/changelog.{zh,en}.md`，由 `.agents/skills/release-notes` skill 生成存档）+ latest*.yml 指针改写 + `download/` 固定入口刷新；本地手动，TOS 凭证限内网，配置见 kimi-cli-cdn-sync 仓 README）。
- `.github/workflows/desktop-build.yml`：desktop 打包流水线（workflow_dispatch 手动触发 + workflow_call 供 release.yml 调用，matrix 出 macOS arm64/x64、Windows、Linux 四平台安装包 + electron-updater 元数据 latest*.yml/blockmap，产物以 `kimi-code-app-<target>` 命名进 artifacts）。macOS 签名/公证用 `.github/actions/macos-keychain-{setup,cleanup}` composite action（源自 kimi-code 仓同名 action），需在 repo Secrets 配置 5 个 `APPLE_*` secret，见 workflow 文件头注释；`sign-macos=false` 出未签名包。CI 不可用时的本地替代：`apps/desktop/scripts/package-local-macos.sh`（复用 `apps/desktop/scripts/ci/` 的 setup/cleanup shell 脚本，只打 arm64）。
- `.github/workflows/release.yml` + `.changeset/`：desktop 发版流程（不发 npm）。功能 PR 带 `pnpm changeset` 生成的 changeset（只选 `kimi-code-app`，见硬约束）合入 main 后，action 自动开 `ci: release desktop` 版本 PR；版本 PR 合入即调 desktop-build 打四平台签名包，并创建 GitHub Release（tag `v<version>`）挂上全部安装包与 latest*.yml/blockmap。细节见 `.changeset/README.md`。CDN 分发不在 CI：Release 就绪后本地跑 `./publish-desktop-cdn.sh <version>`（仓根目录），把产物双推国内 `code.kimi.com/kimi-code/desktop/`（TOS `kimi-code`）与海外 `code.kimi.ai/kimi-code/desktop/`（TOS `kimi-code-oversea`）、切换自动更新指针并刷新 `desktop/download/` 固定下载入口（官网链接，TOS 凭证限内网；脚本 2026-07 从 kimi-cli-cdn-sync 仓迁入本仓）。发布前先用 `release-notes` skill 生成该版本的中英双语 changelog 并 review 存档（`release-notes/<version>/changelog.{zh,en}.md`），脚本会随版本目录一并上传（缺失仅警告，供更新弹窗展示）。

## 常用命令

```bash
pnpm run sync      # git submodule update --init --recursive
pnpm install       # 装依赖（首次或 workspace 变动后；postinstall 会准备共享字体）
pnpm prepare:fonts # 手动准备共享字体（install/dev/build 会自动执行并复用已校验的本地文件）
pnpm build:icons   # 从 KIMI CODE LOGO/ 品牌源文件重新生成全部图标资源（apps/desktop/build/、web favicon、组件内联品牌标）
pnpm dev:desktop   # 桌面端（renderer HMR + 默认启动内嵌 server）
pnpm dev:desktop:debug  # 桌面端，并开启 Electron remote debugging（端口 9222，供 agent-browser 连接）
pnpm dev:web       # Web UI（Vite，代理到 127.0.0.1:58627）
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop  # 外部 server 模式（不起内嵌 server）
pnpm run sync:web  # 同步 web dist 到 kimi-code checkout（先 build web）
pnpm package:macos # 本地打包并签名 macOS arm64 包（CI 不可用时的替代，凭证见 apps/desktop/README.md）
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
- **web 改动同步**：`pnpm --filter kimi-code-web run build` → `KIMI_CODE_REPO=<kimi-code checkout> pnpm run sync:web`。
