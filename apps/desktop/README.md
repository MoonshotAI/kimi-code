# Kimi Code 桌面端

Electron 桌面客户端（产品名 **Kimi Code**，workspace 包 `kimi-code-app`）。主进程在进程内直接启动内嵌 server（源码来自 `kimi-code/` submodule 的 packages，经 `@moonshot-ai/*` 包名引入），渲染进程加载 `apps/web` 的副本（`src/renderer/`），经自定义协议 `app://renderer` 提供给窗口。

仓库级说明——快速开始、下载、双仓联调、发布流程、目录——见[根目录 README](../../README.md)；改动约束与双仓工作流见根目录 `AGENTS.md`；desktop 专属的原生功能分叉清单见 `docs/native-todos.md`。

- 开发：`pnpm dev:desktop`（renderer HMR + 内嵌 server；主进程改动需重启 dev）
- 本地签名打包：`pnpm package:macos`（arm64；凭证与流程见 `scripts/package-local-macos.sh` 头注释）
- CI 打包：`.github/workflows/desktop-build.yml`（macOS arm64/x64 + Windows + Linux 四平台，用法见文件头注释）
