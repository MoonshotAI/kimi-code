# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web UI（`apps/web`）+ 共享包（`packages/*`）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引入。

## 现状与仓库关系

- **本仓库是 Web UI 和桌面端源码的主仓库**。这两个应用此前住在 kimi-code 仓库（`apps/kimi-web` / `apps/kimi-desktop`），今后 web/desktop 的开发都在本仓库进行。
- **kimi-code 是 CLI / server / agent 的主仓库**，以 submodule 钉在本仓库根目录，其 `packages/*` 通过 pnpm workspace 直接以源码链接进来——desktop 的 Electron 主进程会把其中的 server（`kap-server`、`agent-core-v2` 等）打包为内嵌 server。
- **web 产物分发**：`pnpm sync:web`（`scripts/sync-web-to-kimi-code.mjs`）把 `apps/web/dist` 拷贝到一个 kimi-code checkout 的 `apps/kimi-code/dist-web`，用 `KIMI_CODE_REPO` 指定目标 checkout（必传）。
- **Windows 窗口 chrome**：desktop 用 Window Controls Overlay 保留原生窗口按钮，并由 renderer 绘制品牌与文件/编辑/视图/帮助菜单入口。
- **desktop 遥测**：仅内嵌 server 模式由主进程给 agent-core-v2 接入 CloudAppender；宿主与 renderer 事件经本地白名单汇入同一管线，遵循配置项 `telemetry` 与 `KIMI_DISABLE_TELEMETRY`，退出时等待最终 flush。`system-metrics.ts` 周期采样主进程/Chromium 子进程内存 CPU 与 renderer JS 堆（`system_metrics`，口径对齐 CLI v1）。事件契约与分叉范围见 `apps/desktop/docs/native-todos.md`。

## 下载

桌面端最新安装包（CDN 固定入口，永远指向最新版本）：

macOS · Apple Silicon

```
https://code.kimi.com/kimi-code/desktop/download/KimiCode-mac-arm64.dmg
```

macOS · Intel

```
https://code.kimi.com/kimi-code/desktop/download/KimiCode-mac-x64.dmg
```

Windows

```
https://code.kimi.com/kimi-code/desktop/download/KimiCode-win-x64.exe
```

Linux · AppImage

```
https://code.kimi.com/kimi-code/desktop/download/KimiCode-linux-x86_64.AppImage
```

Linux · deb

```
https://code.kimi.com/kimi-code/desktop/download/KimiCode-linux-amd64.deb
```

历史版本与完整产物见 [GitHub Releases](https://github.com/MoonshotAI/kimi-code-app/releases)。

## 快速开始

```bash
pnpm run sync      # 初始化/更新 submodule
pnpm install       # 安装依赖，并在 postinstall 下载、校验及转换缺失的共享字体
pnpm prepare:fonts # 可选；手动重新校验/准备共享字体
pnpm dev:desktop   # 桌面端（renderer HMR + 默认启动内嵌 server）
pnpm dev:desktop:debug  # 桌面端，并开启 Electron remote debugging（端口 9222，供 agent-browser 连接）
pnpm dev:web       # Web UI（Vite dev server，/api/v1 代理到 127.0.0.1:58627）
```

## 用 agent-browser 自动化桌面端

桌面端支持通过 Chrome DevTools Protocol 被外部工具控制，方便做自动化测试或 UI 操作。

1. 安装 `agent-browser`：

   ```bash
   npm i -g agent-browser && agent-browser install
   ```

2. 用 debug 模式启动桌面端（默认开启 `127.0.0.1:9222`）：

   ```bash
   pnpm dev:desktop:debug
   ```

3. 在另一个终端连接并操作：

   ```bash
   agent-browser connect 9222
   agent-browser snapshot -i     # 查看可交互元素
   agent-browser click @e2       # 例如点击 New Chat
   agent-browser screenshot app.png
   ```

更多用法见 `agent-browser skills get electron`。

## 开发

- **联调 kimi-code 的 server 改动**：在你的 kimi-code 工作克隆里 `pnpm dev:server`，然后 `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop`（desktop 不再启动内嵌 server）。完整流程见 `AGENTS.md` 的"双仓工作流"。
- **web 改动同步到 kimi-code**：先 `pnpm --filter kimi-code-web run build`，再 `KIMI_CODE_REPO=<kimi-code checkout 路径> pnpm sync:web`。
- **升级 submodule**：在 `kimi-code/` 内 checkout 目标 commit，然后在根目录提交 submodule 指针；新克隆或拉取后跑 `pnpm run sync` 对齐。
- **常用检查**：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`。
- **更新品牌图标**：设计源文件在 `KIMI CODE LOGO/`（设计师交付，整目录替换后跑 `pnpm build:icons`，重新生成 `apps/desktop/build/` 图标、web favicon 与组件内联品牌标；几何约定见 `scripts/build-brand-icons.mjs` 头注释）。macOS Tahoe 深色/玻璃图标需另在 Icon Composer（Xcode 26）手工制作 `AppIcon.icon` 放入 `apps/desktop/build/`，打包时自动编译嵌入；没有该文件则全平台保持 `.icns` 静态图标。
- **UI 设计系统**：改 UI 前必读 `apps/desktop/src/renderer/views/DesignSystemView.vue`（应用内长按侧栏 logo 打开），样式只用 `style.css` 的设计 token（动效除 `--duration-*` / `--ease-*` 外，含设计师导出图标动画的 `--anim-*` 例外，见 §02 Motion），并在亮色 + 暗色下做视觉验证。细则见 `AGENTS.md` 的"硬约束"。
- **主进程原生界面文案**：新增用户可见字符串（托盘、通知、对话框等）要 en/zh 双语——主进程无 i18n runtime，用 `apps/desktop/src/main/tray.ts` 同款字符串表，应用语言经 `kimi:locale` 通道同步（OS 语言兜底）。细则见 `AGENTS.md` 的"硬约束"。
- **应用菜单（menu.ts）**：编辑菜单不用 `editMenu` 角色而是手工拼装——原生菜单加速键会先于 renderer 截获按键；「全选」保留 CmdOrCtrl+A 加速键但经 `kimi:menu-action` 转发 renderer 的作用域全选（只选中中间 transcript 或注意力所在面板）。改动菜单时保持该契约，其余编辑项镜像 Electron editMenu 展开（`tests/main/menu.test.ts` 钉住）。
- **文本框原生右键菜单（context-menu.ts）**：Electron 无默认编辑菜单，`context-menu.ts` 在 `webContents` 的 `context-menu` 事件里对可编辑字段（transcript 搜索框、composer、内联重命名等）弹原生菜单——macOS 带 Look Up（走 `showDefinitionForSelection`），其余编辑动词走 role + `editFlags` 门控；全部条目显式双语 label（role 默认 label 只随 OS locale），菜单每次右键重建，切语言即时生效。安装点：`window.ts` 的 `createWindow`（`installExternalLinkGuard` 同款）；明细见 `apps/desktop/docs/native-todos.md`。
- **内置终端（terminal.ts）**：desktop 专属，PTY 由主进程 `node-pty` 直接托管（不经内嵌 server），经 `kimi:terminal-*` IPC 与 renderer 的 `useNativeTerminal.ts` + `components/terminal/` 交互；⌃\` 或 View 菜单开合底部面板，多 tab，终端状态按 sessionId 分桶（切 session 原样恢复，上限 10 个 session LRU 驱逐）；shell 解析 POSIX `$SHELL` / Windows pwsh→powershell→cmd；退出 app、renderer 重载/崩溃时全清；xterm 聚焦时原生菜单 accelerator 经 `kimi:menu-terminal-focus` 摘除（否则 Windows 下 Ctrl+C 到不了 PTY）。明细见 `apps/desktop/docs/native-todos.md`。
- **Windows 标题栏**：使用 Window Controls Overlay 保留原生窗口按钮，左侧依次为图标随主题同向切换（浅色白底、深色深底）的完整品牌、常驻侧栏切换、文件/编辑/视图/帮助菜单及按状态出现的更新入口；Windows 托盘固定使用带白色背景的完整品牌图标，Sidebar 不渲染品牌 Header，也不重复这些 chrome 控件。
- **注释克制**：密度对齐所在文件，不写复述代码的注释；设计决策与 bug 根因进 spec / commit message，不进代码。细则见 `AGENTS.md` 的"硬约束"。
- **本地打包并签名 macOS 包**：`pnpm package:macos`（CI 不可用时的替代，arm64；凭证与流程见 `apps/desktop/README.md` 的"打包"一节）。

## 发布

桌面端发版与产物分发（不发 npm）：

1. **changeset**：功能 PR 按 `.agents/skills/changeset/SKILL.md` 生成 changeset（只选 `kimi-code-app`，早期一律 patch）；合入 main 后 CI 自动维护 `ci: release desktop` 版本 PR。
2. **打包**：合并版本 PR，CI 自动打四平台签名包（macOS arm64/x64、Windows、Linux，含 `latest*.yml` 自动更新元数据）并创建 GitHub Release（tag `v<version>`）。完整流程见 `.changeset/README.md`。
3. **双语更新说明**：按 `.agents/skills/release-notes/SKILL.md` 生成该版本的中英双语 changelog——从 `apps/desktop/CHANGELOG.md` 抽取中文案、翻译成英文，review 后存档到 `release-notes/<version>/changelog.{zh,en}.md` 并提交；发布脚本会随版本目录一并上传，更新弹窗按系统语言展示（旧版本无此文件，弹窗不显示更新说明）。
4. **CDN 分发**（本地手动，TOS 凭证限内网）：

   ```bash
   ./publish-desktop-cdn.sh            # 拉最新 Release：传产物 + 切自动更新指针 + 刷新下载入口
   ./publish-desktop-cdn.sh 0.0.3      # 指定版本（rebuild / 补传 / 回滚切指针）
   ./publish-desktop-cdn.sh 0.0.3 --artifacts-only   # 只传产物，先验证再切流量
   ```

   产物双推两条 CDN 链路——国内 `code.kimi.com/kimi-code/desktop/`（TOS `kimi-code`）与海外 `code.kimi.ai/kimi-code/desktop/`（TOS `kimi-code-oversea`），内容一致：版本目录 `binaries/<version>/`（immutable，含安装包与双语更新说明 `changelog.{zh,en}.md`；过渡期 changelog 会同时往旧布局 `<version>/` 传一份副本供未升级客户端拉取，两个版本后停）、自动更新指针 `latest*.yml`（no-cache）、固定下载入口 `download/`（官网链接见上方"下载"一节）。

## 目录

- `apps/desktop`：Electron 桌面端（`kimi-code-app`）
- `apps/web`：浏览器 Web UI（`kimi-code-web`）
- `packages/*`：web 共享包（web-core / web-i18n / web-markdown / web-ui / vite-preset）；字体许可证及本地生成（不入 Git）的两端共用字体位于 `packages/web-ui/src/assets/fonts`
- `scripts/prepare-fonts.mjs`：下载并校验共享源字体，再转换为 Vite/Electron 使用的 WOFF2；install/dev/build 会自动调用
- `KIMI CODE LOGO/` + `scripts/build-brand-icons.mjs`：品牌设计源文件（SVG/PNG）及其到全部图标资源（`apps/desktop/build/`、`apps/web/public/favicon.ico`、组件内联品牌标）的生成脚本（`pnpm build:icons`）
- `kimi-code/`：核心仓 submodule（CLI / server / agent-core / packages）
- `scripts/sync-web-to-kimi-code.mjs`：web 产物同步到 kimi-code 的脚本
