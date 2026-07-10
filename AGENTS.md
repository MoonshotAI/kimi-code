# Repository-level Agent Guide

中文回复用户。本文件是 code-app 仓的 hot-path 规则；改了结构/约束/命令/阶段状态要同步更新本文件。

## 仓库定位

`code-app` 是 Kimi Code 的**客户端仓**：桌面端（`apps/desktop`，Electron）+ Web（`apps/web`，Vue 3）+ 共享包（`packages/*`，阶段 3 引入）。核心仓 `kimi-code` 以 **git submodule** 引用；CLI / server / agent-core 都在 `kimi-code` 仓，不在本仓。

- 设计文档：`docs/specs/2026-07-10-code-app-split-design.md`
- 阶段实施计划：`docs/plans/2026-07-10-code-app-split-phase0.md`（阶段 0 已完成）、`docs/plans/2026-07-10-code-app-split-phase1.md`（阶段 1 已完成）、`docs/plans/2026-07-10-code-app-split-phase2.md`（阶段 2 已完成）、`docs/plans/2026-07-10-code-app-split-phase3.md`（阶段 3 已完成）

## 硬约束

- **依赖方向 `code-app → kimi-code` 单向**。desktop 只经 `@moonshot-ai/*` 包名 import kimi-code 的 packages 源码，**禁止**跨包相对路径 import（`apps/desktop/src/main/sea-path.ts` 与 `scripts/before-pack.cjs` 的运行时 SEA 路径拼接属例外）。`kimi-code` 不得 import `code-app`。
- apps/web 经 `@moonshot-ai/{web-ui,web-markdown,web-core}` 复用共享包；apps/web 不直接 import `kimi-code` 包（依赖方向 `code-app → kimi-code` 单向仍由 desktop 经 `@moonshot-ai/server` | `@moonshot-ai/kimi-code-sdk` 体现）。
- **不改包名**：`@moonshot-ai/kimi-web`、`@moonshot-ai/kimi-desktop` 不改域。
- **提交规范**：Conventional Commits（`chore:` / `feat:` / `fix:` / `docs:`）；**禁止**任何 `Co-Authored-By` 署名；commit message、PR、代码、文档**不得出现** agent / AI 工具的名称或身份信息。
- **不改** `kimi-code` 的 `packages/server`、`packages/agent-core`、`apps/kimi-code/src/**`（核心逻辑在 kimi-code 仓；已获用户逐项认可的拆仓必需改动除外，如阶段 2 server CORS `origin.ts`）。
- Node `>=24.15.0`，pnpm `10.33.0`，`.npmrc` `engine-strict=true`（Node 不符装不上）。

## 工程化

- `pnpm-workspace.yaml` 收编：`apps/*`、`packages/*`、`kimi-code/packages/*`。**不要**加 `kimi-code/apps/kimi-code`——desktop 只 import `@moonshot-ai/server` + `@moonshot-ai/kimi-code-sdk`（都在 `kimi-code/packages/*` 闭包自包含），收编 CLI app 会拖入 `@moonshot-ai/kimi-web` / `@moonshot-ai/vis-*` 导致 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。
- `tsconfig.base.json`：`moduleResolution: bundler`、`allowImportingTsExtensions`、`verbatimModuleSyntax`、`strict`、`noEmit`。各子包 `tsconfig.json` `extends: "../../tsconfig.base.json"`。
- `onlyBuiltDependencies: [electron]`、`zod: "catalog:"`、`overrides(ssh2 native)` 在 `pnpm-workspace.yaml`。
- 构建：web 用 Vite；desktop 主进程用 tsdown（CJS，`electron` external）。各包 `exports → src/*.ts` 直读源码。

## 目录地图

- `apps/desktop`：Electron 壳（`@moonshot-ai/kimi-desktop`）。`src/main/` 主进程；阶段 0 仍 `execFile` 外部 SEA（`sea-path.ts` 解析，`KIMI_SEA_PATH` env 兜底），阶段 1 起改主进程 `import { startServer }`。`scripts/copy-web-dist.mjs` 构建期把 `apps/web/dist` 拷到 `apps/desktop/web-dist/`。
- `apps/web`：浏览器 Web UI（`@moonshot-ai/kimi-web`，Vue 3 + Vite + vue-i18n）。`build → dist`。阶段 3 起聚合三包；`src/api` 仅留 `bootstrap`/`config`/`daemon/agentEventProjector`/`errors`/`index`/`types`（i18n/toolMeta 耦合留 web）。
- `packages/*`：阶段 3 已就位：`@moonshot-ai/{web-ui,web-markdown,web-core}`（exports→src，被 apps/web 复用）。
- `kimi-code/`：git submodule（核心仓）。`kimi-code/packages/*` 提供 server/agent-core/node-sdk 等源码；`kimi-code/apps/kimi-code/dist-web/` 接收本仓 sync 的 web 快照供 SEA 内嵌。
- `scripts/`：仓级脚本（`sync-web-to-kimi-code.mjs`）。
- `docs/specs`、`docs/plans`：设计与阶段实施计划。

## 常用命令

```bash
pnpm run sync      # git submodule update --init --recursive（本地路径 submodule 需 protocol.file.allow=always）
pnpm install       # 装依赖（首次或 workspace 变动后）
pnpm dev:desktop   # 启动桌面端（阶段 0 spawn SEA：先 build SEA 并设 KIMI_SEA_PATH，或在 submodule 工作树 build dist-native）
pnpm dev:web       # 启动 web（vite）
pnpm run sync:web  # build web dist → 同步到 kimi-code 的 apps/kimi-code/dist-web（KIMI_CODE_REPO 可覆盖目标仓，默认 ../kimi-code-2）
pnpm build         # pnpm -r run build
pnpm typecheck     # desktop + web typecheck
```

## 双仓工作流（开发期）

- `kimi-code` 侧改动（CLI/server/core）在本地 `kimi-code-2` 仓的分支进行；code-app 经 submodule 引用其 commit。`kimi-code-2` 有新 commit 后：
  ```bash
  cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
  git fetch origin <branch> && git checkout <commit>
  cd /Users/moonshot/Desktop/moonshot/code-app
  git add kimi-code && git commit -m "chore: bump kimi-code submodule"
  ```
- web dist 同步：`code-app` build web → `pnpm run sync:web` → 在 `kimi-code` 仓提交 `dist-web` 快照（vendoring，被 `.gitignore` 忽略需 `git add -f`）供 SEA 内嵌。

## 阶段路线图

- **阶段 0 拆仓地基（已完成）**：本仓可 install/dev；kimi-code SEA 消费 dist-web 快照。
- **阶段 1 server 内嵌**：desktop 主进程 `import { startServer }` 起桌面端**私有 server**（home 与 CLI 共享、lock/端口独立、`serviceOverrides` 中和 `process.exit`、异步启动不阻塞首屏、去 SEA 分发）。
- **阶段 2 本地 renderer + IPC**：`loadFile` 本地壳 + `preload`/`contextBridge` 注入 serverInfo，替换 `console-message` 主题 hack。
- **阶段 3 仓内抽共享包**：`packages/web-ui|web-markdown|web-core`（解 `useKimiWebClient` 单例为工厂），web/desktop 复用，全程不跨仓。

## 开放点

- `submodule url` 为本地绝对路径（分发前改 github URL + `branch = main` + pin main commit）。
- `dist-web` 快照进 git 的体积治理（后续可改 artifact 下载）。
- `kimi-code/flake.nix` 的 `pnpmDeps.hash`（kimi-code 仓 nix 车道，merge 前回填）。
- 桌面端 CI 在 code-app 自建（阶段 1 之后）。

## 维护本文件

- 改了仓库结构、依赖方向、workspace 收编边界、命令、阶段状态、硬约束时，**必须**同步更新本 `AGENTS.md`。
- 只影响特定子目录的规则放最近的子目录 `AGENTS.md`（如有）；影响全仓的放本文件。
- 规则变更要有代码事实支撑，不写与实现不符的指引。
