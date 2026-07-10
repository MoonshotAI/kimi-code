# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web（`apps/web`）+ 共享包（`packages/*`，阶段 3 引入）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引用。

## 快速开始

```bash
pnpm run sync      # 初始化/更新 submodule
pnpm install
pnpm dev:desktop   # 启动桌面端（阶段 0：主进程仍 spawn SEA）
```

## 目录

- `apps/desktop`：Electron 桌面端（`@moonshot-ai/kimi-desktop`）
- `apps/web`：浏览器 Web UI（`@moonshot-ai/kimi-web`）
- `kimi-code/`：核心仓 submodule（CLI / server / agent-core / packages）
- `docs/specs`、`docs/plans`：设计与实施计划
