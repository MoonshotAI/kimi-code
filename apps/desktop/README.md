# Kimi Code 桌面端

Electron 桌面客户端（产品名 **Kimi Code**，workspace 包 `kimi-code-app`）。主进程在进程内直接启动内嵌 server（源码来自本仓 `packages/` 的 `@moonshot-ai/*` 包），渲染进程（`src/renderer/`，同时是 Web UI 的唯一源码，web 构建变体见 `vite.web.config.ts`）经自定义协议 `app://renderer` 提供给窗口。

主进程源码入口为 `src/main/app/index.ts`，目录划分见根目录 `AGENTS.md`。

仓库级说明——快速开始、开发命令、目录——见[根目录 README](../../README.md)；改动约束见根目录 `AGENTS.md`；desktop 专属的原生功能分叉清单见 `docs/native-divergence.md`。

- 开发：`pnpm dev:desktop`（renderer HMR + 内嵌 server；主进程改动需重启 dev）
- 本地签名打包：`pnpm package:macos`（arm64；凭证与流程见 `scripts/package-local-macos.sh` 头注释）
- CI 打包：`.github/workflows/desktop-build.yml`（macOS arm64/x64 + Windows + Linux 四平台，用法见文件头注释）
