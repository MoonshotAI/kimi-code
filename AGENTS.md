# 仓库级 Agent 指南

使用中文回复。

Kimi Code CLI 的 TypeScript monorepo。AI agent 辅助开发是工作流的一部分——本文件只包含跨包的关键规则，每一条回答"没有这个提示 agent 是否可能出错"。

## 环境要求

- Node.js >= 24.15.0（`.nvmrc` 锁定 24.15.0）
- pnpm 10.33.0（`packageManager` 字段）
- `.npmrc` 设 `engine-strict=true`，版本不满足时 `pnpm install` 直接失败

## 项目地图

**应用层（apps/）：**
- `kimi-code` — CLI/TUI。入口链: `main.ts → cli/commands.ts → KimiHarness → tui/kimi-tui.ts`。修改 TUI 请加载 `write-tui` skill。禁止直接 import `@moonshot-ai/agent-core`，只能通过 `@moonshot-ai/kimi-code-sdk`。
- `kimi-web` — Vue 3 + Vite + vue-i18n 浏览器 UI，通过 REST + WebSocket (`/api/v1`) 与 server 通信。见 `apps/kimi-web/AGENTS.md`。
- `kimi-inspect` — kap-server debug RPC 的 Web Inspector（`/api/v1/debug/*`）。
- `vis` / `vis/server` / `vis/web` — 会话回放和调试可视化。
- `vscode` — VS Code 扩展。

**核心包（packages/）：**
- `agent-core` (v1) — 旧版引擎。`agent-core-v2` — 新引擎（DI × Scope 架构，WIP 迁移中）。见 `packages/agent-core-v2/AGENTS.md`。
- `kap-server` — 服务端，由 v2 驱动。暴露 REST + WebSocket (`/api/v1` + `/api/v1/ws`)。
- `kosong` — LLM / provider 抽象层。
- `kaos` — 执行环境和文件/进程抽象。
- `klient` — 客户端 SDK，v2 的契约门面。两种传输 (`/ipc` 和 `/memory`)。见 `packages/klient/AGENTS.md`。
- `transcript` — 跨平台 transcript 渲染数据层（纯 TS，无引擎依赖）。
- `minidb` — 嵌入式 JSON 文档存储+全文索引。
- `node-sdk` — 公开 SDK（`@moonshot-ai/kimi-code-sdk`）。
- `pi-tui` — TUI 底层框架。
- `tree-sitter-bash` — TypeScript bash 解析器（无 wasm）。
- `acp-adapter` — Agent Client Protocol 适配器。
- `migration-legacy` — v1→v2 迁移工具。
- `oauth` / `telemetry` / `protocol` — 基础设施包。

**其他：**
- `docs/` — VitePress 双语文档站点。见 `docs/AGENTS.md`。
- `.agents/skills/` — 8 个项目级 skill（`write-tui`、`agent-core-dev`、`gen-changesets` 等）。
- `plugins/` — 插件目录。

## 开发命令

```bash
pnpm install         # 安装依赖
pnpm build           # 构建所有包
pnpm test            # vitest（CI 分 5 shard 运行）
pnpm typecheck       # 先 build:packages，再类型检查
pnpm lint            # oxlint --type-aware
pnpm lint:fix        # oxlint --type-aware --fix
pnpm sherif          # monorepo 一致性校验

pnpm dev:cli         # CLI dev 模式
pnpm dev:cli:v2      # 实验性标志 CLI（KIMI_CODE_EXPERIMENTAL_FLAG=1）
pnpm dev:web         # Web UI dev（端口 5175）
pnpm dev:server      # kap-server（端口 58627）
pnpm dev:v2          # kap-server 多实例（端口 58628）

pnpm --filter <pkg> test      # 包级测试
pnpm --filter <pkg> typecheck # 包级类型检查
```

**注意：**
- `typecheck` 会先构建所有包——不要跳过构建步骤直接运行。
- `pi-tui` 用 `node:test` 而非 vitest，需要独立运行: `pnpm --filter @moonshot-ai/pi-tui test`。
- Windows CI 当前禁用（`if: false`）。

## 工具链

| 用途 | 工具 | 配置 |
|---|---|---|
| 格式化 | oxfmt（内置在 oxlint 中） | `.oxfmtrc.json`（printWidth 100, singleQuote, trailingComma all） |
| 类型检查 | TypeScript 6.0.2 | `module: preserve`, `moduleResolution: bundler`, `target: ES2024`, `strict: true` |
| 测试 | vitest 4.1.4 | 根配置分 projects: `packages/*`, `apps/kimi-code`, `apps/vscode` |
| 构建 | tsdown 0.22.0 | 各包独立 `tsdown.config.ts` |
| lint-staged | oxlint --fix → oxlint --type-aware | 提交前自动检查 |
| 包管理 | pnpm 10.33.0 | workspace `catalog` 共享 `zod` 等依赖 |

## 工作区维护

- `pnpm-workspace.yaml` 是成员真实来源。
- `flake.nix` 中**硬编码**了 `workspacePaths` 和 `workspaceNames`——增删包时**必须**同步更新。
- 检查脚本 `scripts/check-nix-workspace.mjs` 只校验 `@moonshot-ai/kimi-code` 的传递闭包。叶子包缺失 nix 配置不会被检测到——不要依赖检查结果，手动保持同步。
- Nix 构建会先 build Web 资产，再产出 SEA 单二进制。

## 编码约定

- 可选属性直接传 `undefined`，不要条件展开。`{ user }` ✓, `{ ...(user ? { user } : undefined) }` ✗。
- 可选属性类型不需要 `| undefined`。`user?: User` ✓, `user?: User | undefined` ✗。
- 单参数内部方法不要改为 options 对象。
- 非 `index.ts` 的 `index.ts` 用 `export * from './module'`。
- 优先用 `#/` 导入别名（等同 `@/`）。
- 优先追加到现有测试文件，不新建。
- 测试失败优先修复测试，不改实现（除非实现真有 bug）。
- 读代码优先用 `rg` / `rg --files`。

## 实验性功能

在 `packages/agent-core/src/flags/registry.ts` 注册 flag，用 `flags.enabled('name')` 检查。环境变量驱动：
- `KIMI_CODE_EXPERIMENTAL_<NAME>` — 开启单个
- `KIMI_CODE_EXPERIMENTAL_FLAG` — 开启所有
- 发布时改 registry 中 `default` 为 `true`。

## 提交与 PR

- PR 标题必须遵循 Conventional Commit（`feat:`、`fix:`、`chore:` 等），CI 强制检查。
- 填写 PR template——链接 issue、解释问题、描述变更。不留占位文本。
- commit/PR 中不暴露 AI agent 身份（不加 co-author 或 agent 标识）。
- 提交前检查 staged 文件，不提交草稿（handoff.md、*-designs.html 等）。临时文件放 `.tmp/`。

### Changesets

- 所有影响发布产物的 PR 必须包含 changeset。
- 用 `gen-changesets` skill 生成。**禁止自行判定 `major`**——breaking change 时停下面向用户确认。默认 `minor`，不确定时 `patch`。

## 指令文件维护

- 全局规则 → 根 `AGENTS.md`。
- 局部规则 → 最近子目录的 `AGENTS.md`（如 `apps/kimi-code/AGENTS.md`、`packages/klient/AGENTS.md`）。
- 优先从可执行来源（代码、配置、脚本）验证事实，而非文档 prose。
