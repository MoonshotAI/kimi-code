# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kimi Code CLI 的 TypeScript pnpm monorepo 二开 fork。详细跨包规则见 `AGENTS.md`，官方同步流程见 `二开版本同步官方提交指南.md`。本文件只保留 AGENTS.md 未覆盖的仓库身份与二开接缝，以及最常用的命令。

## 仓库身份（最重要，AGENTS.md 未覆盖）

- 这是 MoonshotAI/kimi-code 的**二开 fork**，工作分支 `rebuild-from-fork`，基于官方 `main` tip `98ef0f0b`（领先官方 15 个 commit，漂移 0）。
- 两个远程：
  - `official` → https://github.com/MoonshotAI/kimi-code.git（上游，同步来源）
  - `origin` → https://github.com/wangfeizong1001/kimi-code.git（fork，推送目标）
- 与官方同步 = rebase：`git fetch official main && git rebase official/main`，推送 `git push origin rebuild-from-fork --force-with-lease`。rebase 改写历史，**禁止裸 `--force`**。
- 同步前先 `git branch backup/pre-sync-$(date +%Y%m%d)` 备份；失败回滚 `git rebase --abort && git reset --hard backup/pre-sync-*`。
- 冲突按 `二开版本同步官方提交指南.md` 的风险分级（低=新增文件 / 中=叠加函数 / 高=逐行核对）与接缝区合并原则处理。
- commit/PR 中不暴露 AI agent 身份（不加 co-author 或 agent 标识）；不提交草稿文件（放 `.tmp/`）。

## 常用命令

环境：Node.js >= 24.15.0（`.nvmrc` 锁定），pnpm 10.33.0（`.npmrc` `engine-strict=true`）。

```bash
pnpm install                          # 安装依赖
pnpm build                            # 构建所有包
pnpm test                             # vitest 全量（CI 分 5 shard）
pnpm typecheck                        # 先 build:packages 再类型检查——不要跳过构建直接跑
pnpm lint / pnpm lint:fix             # oxlint --type-aware
pnpm sherif                           # monorepo 一致性校验

pnpm dev:cli                          # CLI dev 模式
pnpm dev:cli:v2                       # 实验性标志 CLI（KIMI_CODE_EXPERIMENTAL_FLAG=1）
pnpm dev:web                          # kimi-web dev（端口 5175）
pnpm dev:server                       # kap-server（端口 58627）
pnpm dev:v2                           # kap-server 多实例（端口 58628）

pnpm --filter @moonshot-ai/<pkg> test | typecheck   # 包级
pnpm --filter @moonshot-ai/pi-tui test              # pi-tui 用 node:test，root vitest 不跑
pnpm --filter @moonshot-ai/kimi-web check:style     # 前端设计系统反模式检查
```

注意：`dev:server` / `dev:kap-server` 系列内置 `--dangerous-bypass-auth --debug-endpoints`（二开入口）。

## 架构总览

- 应用层 `apps/`：
  - `kimi-code` — CLI/TUI。入口链 `src/main.ts → cli/commands.ts → KimiHarness → tui/kimi-tui.ts`。改 TUI 加载 `write-tui` skill。
  - `kimi-web` — Vue 3 + Vite + vue-i18n 浏览器 UI，REST + WebSocket `/api/v1` 连 server（默认代理 127.0.0.1:58627）。无路由/Pinia，状态在 composables/refs；设计令牌在 `src/style.css`。
  - `kimi-inspect`（kap-server debug Web Inspector）、`vis`（会话回放可视化）、`vscode`。
- 核心包 `packages/`：
  - `agent-core`（v1 旧引擎）/ `agent-core-v2`（新引擎，DI × Scope，WIP 迁移中）。
  - `kap-server` — 服务端，由 v2 驱动，暴露 `/api/v1` + `/api/v1/ws`。
  - `klient` — v2 客户端 SDK 契约门面，两种传输（ipc / memory）。
  - `kosong`（LLM/provider 抽象）、`kaos`（执行环境）、`node-sdk`（公开 SDK）、`oauth` / `telemetry` / `protocol` / `minidb` / `transcript` / `acp-adapter` / `pi-tui`。
- 硬约束：app 层（kimi-code / kimi-web）**禁止直接 import `@moonshot-ai/agent-core`**——走 `@moonshot-ai/kimi-code-sdk`；kimi-web 与 v2 的 wire 类型在本地 `src/api/daemon/wire.ts` 复刻。

## 二开功能接缝（相对官方 main 的增量）

这些是 fork 新增、rebase 时需按接缝原则合并的功能：

- Provider 管理：kap-server `PATCH /api/v1/providers/{id}` 路由、`apps/kimi-web/src/components/settings/ProviderManager.vue`、`packages/oauth` 泛用 OpenAI 兼容 provider（含国内厂商预设）。
- MCP 配置管理：`/api/v1/mcp/config/servers` 路由 + 前端标签页。
- 用户级 Skill 可视化 CRUD（`/skills` 相关路由 + 设置页）。
- Git 分支切换：kimi-web `ChatHeader.vue` 下拉 + kap-server session `:git-branches` / `:git-checkout` actions、agent-core-v2 `IGitService`。
- fs 写入 action（kap-server + agent-core-v2 workspaceFs）。
- kimi-web 移除 auth gate；kimi-code 增加 `--dangerous-bypass-auth` 开发开关。

## 核心约定（节选，完整规则见 AGENTS.md）

- 可选属性直接传 `undefined`，不做条件展开；类型不用 `| undefined`。
- 优先 `#/` 导入别名；非包的 `index.ts` 用 `export * from './module'`。
- 测试优先追加到现有文件；测试失败优先修测试不改实现（除非实现真有 bug）。
- 读代码优先 `rg` / `rg --files`。
- 实验性功能：在 `packages/agent-core/src/flags/registry.ts` 注册 flag，`KIMI_CODE_EXPERIMENTAL_<NAME>` 或 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 开启，发布时把 registry 中 `default` 改为 `true`。
- 提交与 PR：Conventional Commit 标题（CI 强制），涉及发布产物必须带 changeset（用 `gen-changesets` skill，禁止自行判定 `major`）。

## 指令文件分层

- 全局规则 → 根 `AGENTS.md`；局部规则 → 最近子目录的 `AGENTS.md`（`apps/kimi-code`、`apps/kimi-web`、`packages/agent-core-v2`、`packages/klient`、`packages/pi-tui`、`docs`）。
- 事实优先从代码/配置/脚本验证，而非文档 prose。
