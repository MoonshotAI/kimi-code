# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web UI（`apps/web`）+ 共享包（`packages/*`）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引入。

## 现状与仓库关系

- **本仓库是 Web UI 和桌面端源码的主仓库**。这两个应用此前住在 kimi-code 仓库（`apps/kimi-web` / `apps/kimi-desktop`），今后 web/desktop 的开发都在本仓库进行。
- **kimi-code 是 CLI / server / agent 的主仓库**，以 submodule 钉在本仓库根目录，其 `packages/*` 通过 pnpm workspace 直接以源码链接进来——desktop 的 Electron 主进程会把其中的 server（`kap-server`、`agent-core-v2` 等）打包为内嵌 server。
- **web 产物分发**：`pnpm sync:web`（`scripts/sync-web-to-kimi-code.mjs`）把 `apps/web/dist` 拷贝到一个 kimi-code checkout 的 `apps/kimi-code/dist-web`，用 `KIMI_CODE_REPO` 指定目标 checkout（必传）。

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

## Desktop 自定义协议

### `kimi-code://auth/success`

OAuth 授权完成页唤起桌面端窗口（登录态由 daemon 轮询完成，协议不携带凭证）。对外契约，改动需与授权页团队同步。

## 开发

- **联调 kimi-code 的 server 改动**：在你的 kimi-code 工作克隆里 `pnpm dev:server`，然后 `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop`（desktop 不再启动内嵌 server）。完整流程见 `AGENTS.md` 的"双仓工作流"。
- **web 改动同步到 kimi-code**：先 `pnpm --filter kimi-code-web run build`，再 `KIMI_CODE_REPO=<kimi-code checkout 路径> pnpm sync:web`。
- **升级 submodule**：在 `kimi-code/` 内 checkout 目标 commit，然后在根目录提交 submodule 指针；新克隆或拉取后跑 `pnpm run sync` 对齐。
- **常用检查**：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`。
- **更新品牌图标**：设计源文件在 `KIMI CODE LOGO/`（设计师交付，整目录替换后跑 `pnpm build:icons`，重新生成 `apps/desktop/build/` 图标、web favicon 与组件内联品牌标；几何约定见脚本头注释）。macOS Tahoe 深色/玻璃图标需另在 Icon Composer（Xcode 26）手工制作 `AppIcon.icon` 放入 `apps/desktop/build/`，打包时自动编译嵌入；没有该文件则全平台保持 `.icns` 静态图标。
- **本地打包并签名 macOS 包**：`pnpm package:macos`（CI 不可用时的替代，arm64；凭证与流程见 `apps/desktop/scripts/package-local-macos.sh` 头注释）。
- **改动约束**：依赖方向、UI 设计系统与样式 token、主进程双语文案、提交与 changeset 规范等一律以 `AGENTS.md` 为准；desktop 专属原生功能分叉见 `apps/desktop/docs/native-todos.md`。

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

### alpha 通道

桌面端另有 alpha 预发版通道：常驻 `alpha` 分支处于 changeset pre 模式，合并它的版本 PR 即自动发 `0.0.x-alpha.N`（GH Release 为 prerelease；分支规则见 `.changeset/README.md`）。CDN 发布用同一个脚本，版本号即通道：

```bash
./publish-desktop-cdn.sh 0.0.4-alpha.0   # 只切 alpha*.yml 更新指针；latest*.yml 与 download/ 不动
```

alpha 安装包从 GitHub Release（prerelease）分发，不发双语更新说明；alpha 用户随通道指针持续吃后续 alpha，回正式版需手动安装正式包。方案见 `docs/plans/2026-08-25-desktop-alpha-channel.md`。

## 目录

- `apps/desktop`：Electron 桌面端（`kimi-code-app`）
- `apps/web`：浏览器 Web UI（`kimi-code-web`）
- `packages/*`：web 共享包（app-core / app-i18n / app-markdown / app-ui / vite-preset）
- `kimi-code/`：核心仓 submodule（CLI / server / agent / packages）
- `KIMI CODE LOGO/`：品牌设计源文件（SVG/PNG），下游图标资源由 `pnpm build:icons` 生成
- `scripts/`：字体准备（`prepare-fonts.mjs`）、品牌图标生成（`build-brand-icons.mjs`）、web 产物同步（`sync-web-to-kimi-code.mjs`）等
