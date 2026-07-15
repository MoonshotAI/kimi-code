# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web UI（`apps/web`）+ 共享包（`packages/*`）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引入。

## 现状与仓库关系

- **本仓库是 Web UI 和桌面端源码的主仓库**。这两个应用此前住在 kimi-code 仓库（`apps/kimi-web` / `apps/kimi-desktop`），今后 web/desktop 的开发都在本仓库进行。
- **kimi-code 是 CLI / server / agent 的主仓库**，以 submodule 钉在本仓库根目录，其 `packages/*` 通过 pnpm workspace 直接以源码链接进来——desktop 的 Electron 主进程会把其中的 server（`kap-server`、`agent-core-v2` 等）打包为内嵌 server。
- **web 产物分发**：`pnpm sync:web`（`scripts/sync-web-to-kimi-code.mjs`）把 `apps/web/dist` 拷贝到一个 kimi-code checkout 的 `apps/kimi-code/dist-web`，用 `KIMI_CODE_REPO` 指定目标 checkout（必传）。

## 快速开始

```bash
pnpm run sync      # 初始化/更新 submodule
pnpm install
pnpm dev:desktop   # 桌面端（renderer HMR + 默认启动内嵌 server）
pnpm dev:web       # Web UI（Vite dev server，/api/v1 代理到 127.0.0.1:58627）
```

## 开发

- **联调 kimi-code 的 server 改动**：在你的 kimi-code 工作克隆里 `pnpm dev:server`，然后 `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop`（desktop 不再启动内嵌 server）。完整流程见 `AGENTS.md` 的"双仓工作流"。
- **web 改动同步到 kimi-code**：先 `pnpm --filter @moonshot-ai/kimi-web run build`，再 `KIMI_CODE_REPO=<kimi-code checkout 路径> pnpm sync:web`。
- **升级 submodule**：在 `kimi-code/` 内 checkout 目标 commit，然后在根目录提交 submodule 指针；新克隆或拉取后跑 `pnpm run sync` 对齐。
- **常用检查**：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`。

## 目录

- `apps/desktop`：Electron 桌面端（`@moonshot-ai/kimi-desktop`）
- `apps/web`：浏览器 Web UI（`@moonshot-ai/kimi-web`）
- `packages/*`：web 共享包（web-core / web-i18n / web-markdown / web-ui / vite-preset）
- `kimi-code/`：核心仓 submodule（CLI / server / agent-core / packages）
- `scripts/sync-web-to-kimi-code.mjs`：web 产物同步到 kimi-code 的脚本
