# Repository-level Agent Guide

中文回复用户。本文件是 code-app 仓的 hot-path 规则；改了结构 / 约束 / 命令要同步更新本文件与 `README.md`。

## 仓库定位与现状

- `code-app` 是 Kimi Code 的客户端仓，也是 **Web UI（`apps/web`）和桌面端（`apps/desktop`）源码的主仓库**。CLI / TUI / server / agent 在核心仓 `kimi-code`，以 git submodule 引入（`kimi-code/`，跟踪 `main`），不在本仓开发。
- web 产物经 `scripts/sync-web-to-kimi-code.mjs` 同步到 kimi-code checkout 的 `apps/kimi-code/dist-web`。
- 背景详见 `README.md`。

## 硬约束

- **依赖方向 `code-app → kimi-code` 单向**：desktop 只经 `@moonshot-ai/*` 包名 import kimi-code 的 packages 源码，禁止跨包相对路径 import；`kimi-code` 不得 import `code-app`。
- `apps/web` 只依赖 `@moonshot-ai/{web-core,web-i18n,web-markdown,web-ui}` 共享包，不直接 import kimi-code 的包。
- **不改包名**：`@moonshot-ai/kimi-web`、`@moonshot-ai/kimi-desktop`。
- **两端逐步分叉是既定方向**：desktop 的原生功能（经 `window.kimiDesktop` 桥接，如原生目录选择器）只在 `apps/desktop` 实现；web 刻意保留原有 daemon 接口实现，不回填。原生路径必须带无桥降级（探测不到桥时回退旧实现）。已分叉的功能点记录在 `apps/desktop/docs/native-todos.md`；改两端共有的文件前先查它，手动同步副本时保留 desktop 侧的分叉块。
- **开发顺序**：两端共有的 UI 改动优先在 `apps/desktop` 开发，开发完成后再同步到 `apps/web`（desktop 专属原生功能除外，见上条）。
- **不在本仓直接改 `kimi-code/` submodule 的内容**；kimi-code 侧改动在你的工作克隆里做（见"双仓工作流"），本仓只 bump submodule 指针。
- **提交规范**：Conventional Commits；禁止任何 `Co-Authored-By` 署名；commit message、PR、代码、文档不得出现 agent / AI 工具的名称或身份信息。PR 描述用英文。
- **stage 用显式路径，不用 `git add -A` / `git add .`**：本仓有构建产物目录（如 desktop 的 `desktop-dist`、已清理的 `web-dist`），gitignore 变动会让它们突然"显形"，`git add -A` 会误扫进 commit（2026-07 实际出过一次）。
- Node `>=24.15.0`，pnpm `10.33.0`（`.npmrc` 设 `engine-strict=true`，Node 不符装不上依赖）。

## 目录地图

- `apps/desktop`：Electron 壳（`@moonshot-ai/kimi-desktop`）。`src/main/index.ts` 主进程入口（只做编排；窗口 `window.ts`、菜单 `menu.ts`、快捷键 `shortcuts.ts`、IPC `ipc.ts` + channel 常量 `ipc-channels.ts`、server 连接 `connect.ts`、启动失败页 `screens.ts`）；`src/main/server.ts` 内嵌 server（`startDesktopServer`：回环 + 临时端口 + 独立 lock）；`src/main/connect-target.ts` 外部 server 模式解析（`KIMI_SERVER_URL`，纯函数）；`src/main/protocol.ts` `app://renderer` 协议映射（带 `..` 越界防护）。`pnpm dev` 走 `scripts/dev.mjs`：起 renderer 的 Vite dev server（默认 `http://127.0.0.1:5174`）并把实际端口经 `KIMI_RENDERER_DEV_URL` 传给主进程，`connect.ts` 据此加载 dev server（renderer HMR）并把该 origin 加进内嵌 server 的 CORS 白名单；主进程改动需重启 dev。主进程测试在 `tests/main/`，renderer 测试与源码同目录。细则见 `apps/desktop/README.md`。
- `apps/web`：浏览器 Web UI（`@moonshot-ai/kimi-web`，Vue 3 + Vite + vue-i18n）。dev 时 Vite 把 `/api/v1`（REST + WS）代理到 `KIMI_SERVER_URL`（默认 `http://127.0.0.1:58627`）。
- `packages/*`：`@moonshot-ai/{web-core,web-i18n,web-markdown,web-ui}` + `vite-preset`（exports→src，被 apps/web 与 desktop renderer 复用）；`web-ui/src/assets/fonts` 保存字体许可证与本地生成（gitignored）的两端共用字体产物，dev/build 前由 `scripts/prepare-fonts.mjs` 下载、校验并转换，再由 Vite 打入最终产物。
- `kimi-code/`：git submodule（核心仓）。`kimi-code/packages/*` 提供 `kap-server`、`agent-core-v2`、`kimi-code-sdk` 等源码。
- `scripts/sync-web-to-kimi-code.mjs`：`apps/web/dist` → `<kimi-code checkout>/apps/kimi-code/dist-web`（`KIMI_CODE_REPO` 必传，指定目标 checkout）。
- `.gitlab-ci.yml`：desktop 打包流水线（macOS arm64/x64、Windows、Linux 四个手动触发 job，产物只进 artifacts）。macOS 签名/公证脚本在 `apps/desktop/scripts/ci/`，所需的 5 个 `APPLE_*` CI/CD 变量与 runner 要求见文件头注释。CI 不可用时的本地替代：`apps/desktop/scripts/package-local-macos.sh`（复用 ci/ 的 setup/cleanup，只打 arm64）。

## 常用命令

```bash
pnpm run sync      # git submodule update --init --recursive
pnpm install       # 装依赖（首次或 workspace 变动后）
pnpm prepare:fonts # 手动准备共享字体（dev/build 会自动执行并复用已校验的本地文件）
pnpm dev:desktop   # 桌面端（renderer HMR + 默认启动内嵌 server）
pnpm dev:desktop:debug  # 桌面端，并开启 Electron remote debugging（端口 9222，供 agent-browser 连接）
pnpm dev:web       # Web UI（Vite，代理到 127.0.0.1:58627）
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop  # 外部 server 模式（不起内嵌 server）
pnpm run sync:web  # 同步 web dist 到 kimi-code checkout（先 build web）
pnpm package:macos # 本地打包并签名 macOS arm64 包（CI 不可用时的替代，凭证见 apps/desktop/README.md）
pnpm test          # 根 vitest
pnpm lint          # oxlint --type-aware
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
- **web 改动同步**：`pnpm --filter @moonshot-ai/kimi-web run build` → `KIMI_CODE_REPO=<kimi-code checkout> pnpm run sync:web`。
