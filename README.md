# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web UI（`apps/web`）+ 共享包（`packages/*`）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引入。

## 现状与仓库关系

- **本仓库是 Web UI 和桌面端源码的主仓库**。这两个应用此前住在 kimi-code 仓库（`apps/kimi-web` / `apps/kimi-desktop`），今后 web/desktop 的开发都在本仓库进行。
- **kimi-code 是 CLI / server / agent 的主仓库**，以 submodule 钉在本仓库根目录，其 `packages/*` 通过 pnpm workspace 直接以源码链接进来——desktop 的 Electron 主进程会把其中的 server（`kap-server`、`agent-core-v2` 等）打包为内嵌 server。
- **web 产物分发**：`pnpm sync:web`（`scripts/sync-web-to-kimi-code.mjs`）把 `apps/web/dist` 拷贝到一个 kimi-code checkout 的 `apps/kimi-code/dist-web`，用 `KIMI_CODE_REPO` 指定目标 checkout（必传）。

## 下载

桌面端最新安装包（CDN 固定入口，永远指向最新版本）：

```
macOS · Apple Silicon    https://code.kimi.com/kimi-code/desktop/download/KimiCode-mac-arm64.dmg
macOS · Intel            https://code.kimi.com/kimi-code/desktop/download/KimiCode-mac-x64.dmg
Windows                  https://code.kimi.com/kimi-code/desktop/download/KimiCode-win-x64.exe
Linux · AppImage         https://code.kimi.com/kimi-code/desktop/download/KimiCode-linux-x86_64.AppImage
Linux · deb              https://code.kimi.com/kimi-code/desktop/download/KimiCode-linux-amd64.deb
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
- **UI 设计系统**：改 UI 前必读 `apps/desktop/src/renderer/views/DesignSystemView.vue`（应用内长按侧栏 logo 打开），样式只用 `style.css` 的设计 token，并在亮色 + 暗色下做视觉验证。细则见 `AGENTS.md` 的"硬约束"。
- **本地打包并签名 macOS 包**：`pnpm package:macos`（CI 不可用时的替代，arm64；凭证与流程见 `apps/desktop/README.md` 的"打包"一节）。
- **桌面端发版**：功能 PR 必须按 `.agents/skills/changeset/SKILL.md` 生成并提交 changeset（只选 `kimi-code-app`，早期阶段一律 patch）；合入 main 后 CI 自动开 `ci: release desktop` 版本 PR，版本 PR 合入即自动打四平台签名包并发 GitHub Release。完整流程见 `.changeset/README.md`。Release 就绪后执行 `scripts/publish-desktop-cdn.sh <version>` 同步 CDN（切换自动更新指针 + 刷新 `desktop/download/` 固定下载入口，后者供官网链接）。

## 目录

- `apps/desktop`：Electron 桌面端（`kimi-code-app`）
- `apps/web`：浏览器 Web UI（`kimi-code-web`）
- `packages/*`：web 共享包（web-core / web-i18n / web-markdown / web-ui / vite-preset）；字体许可证及本地生成（不入 Git）的两端共用字体位于 `packages/web-ui/src/assets/fonts`
- `scripts/prepare-fonts.mjs`：下载并校验共享源字体，再转换为 Vite/Electron 使用的 WOFF2；install/dev/build 会自动调用
- `kimi-code/`：核心仓 submodule（CLI / server / agent-core / packages）
- `scripts/sync-web-to-kimi-code.mjs`：web 产物同步到 kimi-code 的脚本
