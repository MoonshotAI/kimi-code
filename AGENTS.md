# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. This file is the single source of truth for project-wide knowledge. Keep it focused on the project map, hard constraints, and workflow requirements — things every task needs to know.

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

- **Author**: Moonshot AI
- **License**: MIT
- **Homepage**: https://github.com/MoonshotAI/kimi-code
- **Version**: `@moonshot-ai/kimi-code` 0.30.0 (the main CLI app)

> **Note**: This repository is a personal experimental fork of MoonshotAI/kimi-code. Not affiliated with Moonshot AI. Use at your own risk — do not submit PRs from this fork to upstream.

### Fork-specific additions vs upstream

- **i18n / Multi-language support** — Complete Chinese-English bilingual support across TUI, CLI, and Web UI. All hardcoded English strings replaced with `t()` calls. Switch locale via `/locale` or the dialog.
- **Swarm Discussion** — Multi-agent discussion and collaboration tool; agents can debate, cross-review, and reach consensus before output.
- **Rust Native Tools** — Performance-critical tools (grep, glob, edit, read, write, bash, token counting, output truncation) rewritten in Rust as a native Node addon, significantly faster than JS.
- **Windows one-click launchers** — `start-native.bat` and `start-desktop.bat` for quick launch on Windows.

---

## Technology Stack

### Languages & Runtimes

| Layer | Technology |
|-------|-----------|
| **Engine (source of truth)** | **Rust** — `kimi-agent` / `kimi-native-tools` / `kimi-shared` (see "Engine Ownership" below) |
| Host / UI language | **TypeScript** 6.0.2 (strict mode) — restricted to the host whitelist (see "Engine Ownership") |
| Module system | ESM (`"type": "module"` in every package) |
| Runtime | **Node.js** >= 24.15.0 (`.nvmrc`: 24.15.0) |
| Native addon | **Rust** via napi-rs (`kimi-native-tools`), SEA via `kimi-build` |
| Web UI (peer) | **Vue 3** + **Vite** |
| VS Code extension | **React 19** + **TailwindCSS 4** + **shadcn/ui** |

### Package Management & Build

| Tool | Purpose |
|------|---------|
| **pnpm** 10.33.0 | Package manager (monorepo with workspace catalog) |
| **tsdown** 0.22.0 | ESM bundler for TypeScript packages |
| **vite** 6.x | Web app bundler (kimi-web, vis-web, vscode webview) |
| **Cargo** | Rust build for `kimi-native-tools` (napi-rs), `kimi-build` (SEA), `kimi-agent` |
| **Nix flake** | Reproducible builds for Linux/macOS |
| **SEA** (Node.js Single Executable Applications) | Self-contained binary distribution |

### Quality Tooling

| Tool | Purpose |
|------|---------|
| **oxlint** 1.59.0 | Linter — correctness (error), suspicious (warn), pedantic (warn), perf (warn) |
| **oxfmt** | Formatter — 100 print width, single quotes, trailing commas, sorted imports |
| **vitest** 4.1.4 | Test runner (v8 coverage provider) |
| **simple-git-hooks** | Pre-commit hooks (runs `lint-staged`) |
| **lint-staged** | Lint staged files with `oxlint --fix --quiet` + `oxlint --type-aware --quiet` |
| **changesets** | Version management and changelog generation |
| **sherif** 1.11.1 | Monorepo correctness checker |
| **publint** + **attw** | Package publishing lint and type-checking |
| **tsgo** (TypeScript native-preview) | CI typechecking |

---

## Engine Ownership — Rust is the source of truth

> **Status (2026-08-03):** the JS agent engines (`agent-core`, `agent-core-v2`) are **retired**. The only engine is the Rust engine (`packages/kimi-agent`). `schema.ts` `engine` enum is `'rust'` only — no JS fallback.
>
> **方向（2026-08-03 定案，2026-08-06 收紧，见 `CODEX_MIGRATION_PLAN.md` 顶部 R 节）**：走 Codex 方向——**核心全部 Rust，只有 web 是 TS**。除浏览器前端（`kimi-web`/`kimi-inspect`/`vis/web`）与必须 JS 的前端壳（`vscode` 扩展宿主、npm bin 包装）外，一切 TS（CLI/TUI/server/SDK/protocol/OAuth/ACP/LLM 抽象/i18n 数据/rust-loop 桥）迁入 Rust 或退役。当前 TS 宿主（CLI/TUI/Web/API，源码约 23 万行）按 `CODEX_MIGRATION_PLAN.md` 的 G-0..G-7 收口路线逐模块迁入 `crates/`（kimi-cli/kimi-tui/kimi-server/kimi-sdk/…）。**迁移进度（2026-08-03 会话）**：阶段 A–E 全部完成（协议/引擎/宿主协议/CLI/exec/TUI/ACP/SDK/OAuth/WS 传输+客户端，测试基线 2890+，三传输路径全 e2e）；阶段 F（入口切换与 TS 退役）按记录决策待 Rust 全绿后执行——npm 分发薄壳（kimi-code-rust-bin）已验证可用。迁移完成前 TS 宿主保留（见下方白名单），**新增宿主逻辑优先写 Rust**；已完成迁移的模块删除对应 TS。

### Where new code goes

- **Engine functionality (session loop, tools, context, goal, plan, approval, permission, MCP, skill, records, compaction …) → Rust only**, in `packages/kimi-agent/src/`, `packages/kimi-native-tools/src/`, or `packages/kimi-shared/src/`. Follow the module map in `packages/kimi-agent/GAP_ANALYSIS.md`. Add `cargo test` coverage and keep `cargo test -p kimi-agent` green (0 warnings).
- **RPC/wire types are generated**: change the Rust type in `src/rpc/types.rs`, then run `pnpm gen:wire` and commit the generated `src/rpc/wire.gen.ts`. Never hand-edit `wire.gen.ts`.
- **Do NOT implement or modify engine behavior in TypeScript.** Both TS engine packages are **retired**: `packages/agent-core` moved to `retired/agent-core/` (2026-08-03) and `packages/agent-core-v2` to `retired/agent-core-v2/` (2026-08-03) once klient switched to the rust transport. Hosts no longer reference either; do not extend them or reintroduce imports.

### TS side is allowed only for the host layer (whitelist) — 过渡期

> 方向修正：白名单是**过渡状态**。目标是"只有 web 是 TS"（`CODEX_MIGRATION_PLAN.md` R 节，G-0..G-7 收口路线）。迁移完成一个模块，删除对应 TS。

| Scope | Files | Reason |
|-------|-------|--------|
| Rust bridge / adapter | `apps/kimi-code/src/cli/rust-engine.ts`, `apps/kimi-code/src/cli/native-session.ts` | glue host ↔ Rust RPC |
| Generated files | `packages/kimi-agent/src/rpc/wire.gen.ts` | regenerated via `pnpm gen:wire`, never hand-edited |
| CLI / TUI / Web / VS Code shells | `apps/*` UI + i18n | pure UI, no engine logic（目标迁入 crates/） |
| Test adaptation | TS tests asserting against the Rust engine | keep host behavior verified |

Before writing any TS change, ask: *is this engine functionality?* If yes → implement in Rust. If it is host/UI → TS is fine **for now, but prefer Rust** (see `CODEX_MIGRATION_PLAN.md`).

### TS 冻结清单（FROZEN）— 2026-08-10 生效

> 冻结 = **废弃标记**（G-6 物理退役前置未满足，先冻结防扩散）。下列 TS 包/文件一律视为**冻结**：任何会话不得在其中新增功能、引擎逻辑、行为修补或边缘语义打磨。冻结包入口的 FROZEN banner 不得删除。

**允许**：关键 bug 修复（崩溃 / 数据丢失 / 安全 / 生产日志污染）；测试基线必要适配（2026-08-05 测试策略："TS 层仅做基线必要适配，不深挖过渡层边缘行为"）。
**禁止**：新增功能、引擎逻辑、行为修补、UI 微调。新能力一律写 Rust（`kimi-sdk` / `kimi-agent` / `crates/*`）；修 TS bug 前先核对 Rust 侧是否已有等价能力或修复。

| 冻结包 | 目标 Rust | 备注 |
|---|---|---|
| `packages/transcript` / `packages/telemetry` | 收编/退役 | — |
| `packages/migration-legacy` | 退役 | 一次性数据迁移 |
| `packages/pi-tui` | 退役 | — |
| `apps/kimi-code` 剩余 TS（`src/main.ts` 入口） | kimi-cli | G-3 切换中 |

> **2026-08-10 已退役（→ `retired/`）**：`node-sdk`、`kap-server`、`acp-adapter`、`oauth`、`protocol`、`kaos`、`kosong`——不再扩展、不再恢复；引用它们的代码不得回引。`kimi-agent/rust-loop.ts` 与 `kimi-agent/runtime/`（TS 桥/兼容层）已删除（2026-08-10）——kimi-agent 包仅剩 Rust + 生成文件 `src/rpc/wire.gen.ts`；apps/kimi-code 经 `NativeServerClient`（stdio RPC）直连引擎。

**保留 TS（不受冻结）**：`kimi-web` / `kimi-inspect` / `vis/web`（web 前端）、`apps/vscode`（壳）、npm 薄壳（`kimi.mjs`）——仍遵守"引擎逻辑不得写 TS"白名单。

---

## Project Structure

### Apps

```
apps/
  kimi-code/        — Main CLI / TUI application (entry point)
  kimi-web/         — Browser web UI (Vue 3 + Vite)
  vscode/           — VS Code extension (React 19 webview)
  kimi-inspect/     — Web inspector for the Rust kimi-server /api/v1/debug RPC surface
  vis/              — Session replay & debugging visualizer
```

#### `apps/kimi-code` — CLI / TUI Application

The main application. Consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must **not** depend directly on `@moonshot-ai/agent-core`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).

**Source layout:**

```
src/
  main.ts             — Entry point
  cli/                — CLI mode (headless)
    commands.ts       — CLI command definitions
    options.ts        — CLI option parsing
    sub/              — Subcommands (acp, doctor, export, login, provider, upgrade, vis, web)
    update/           — Self-update mechanism
  tui/                — Terminal UI mode
    kimi-tui.ts       — TUI initialization and main loop
    config.ts         — TUI configuration
    banner/           — Startup banner
    commands/         — Slash command handlers (26+ commands)
    components/       — UI components (panes, messages, dialogs, editor, media)
    controllers/      — UI controllers (auth-flow, session, streaming, keyboard, etc.)
    theme/            — Theme system
    reverse-rpc/      — Reverse RPC for ACP communication
  i18n/               — Localization setup
  native/             — Native module integration
  migration/          — Data migration
  feedback/           — User feedback collection
  utils/              — Shared utilities
  constant/           — Constants
  generated/          — Generated asset references
```

**CLI subcommands:** `acp`, `doctor`, `export`, `login`, `login-flow`, `plugin-run-node`, `provider`, `upgrade`, `vis`, `web`

**TUI slash commands (26+):** `add-dir`, `auth`, `btw`, `complete-args`, `config`, `copy`, `discuss`, `dispatch`, `experimental-flags`, `goal`, `info`, `parse`, `plugin-commands`, `plugins`, `prompts`, `provider`, `registry`, `reload`, `resolve`, `session`, `skills`, `swarm`, `types`, `undo`, `web`, `workflow`

**Build output:**
| Output | Path |
|--------|------|
| CLI entry (ESM) | `apps/kimi-code/dist/main.mjs` |
| Web UI assets | `apps/kimi-code/dist-web/` |
| Native prebuilds | `apps/kimi-code/native/` |
| SEA binary | `apps/kimi-code/dist-native/bin/` |

#### `apps/kimi-web` — Browser Web UI

Peer to the TUI. Vue 3 + Vite + vue-i18n; talks to the server over REST + WebSocket under `/api/v1`. It must not depend on `@moonshot-ai/agent-core` (wire types are re-implemented locally). Debug against the Rust-backed server via the root `pnpm dev:v2` script. See `apps/kimi-web/AGENTS.md`.

#### `apps/vscode` — VS Code Extension

Full-featured VS Code extension (`kimi-code` in marketplace). React 19 webview UI with TailwindCSS 4, communicates with the main kimi-code server over local REST/WS.

Key contributions:
- Sidebar webview panel
- Commands: `kimi.focusInput`, `kimi.insertMention`, `kimi.newConversation`, `kimi.showLogs`, etc.
- Settings: `kimi.yoloMode`, `kimi.autosave`, `kimi.editorContext`, etc.
- Packaging: vsix via `@vscode/vsce`, published to both VS Code Marketplace and OpenVSX

#### `apps/kimi-inspect` — Web Inspector

Web inspector for the Rust kimi-server `/api/v1/debug` RPC surface. Workspace/session browser, per-session chat, and Service panels. React 19 + Vite. Built on a `ProxyChannel` model similar to VS Code.

#### `apps/vis` — Session Visualizer

Debug visualization tool for kimi-code sessions. Composed of `vis/server` (backend) and `vis/web` (frontend). Sessions and replays can be inspected via a web UI.

### Packages

```
packages/
  agent-core-v2/     — Agent engine v2 (DI × Scope architecture) — FROZEN (see below)
  kosong/            — LLM / provider abstraction layer
  klient/            — Client SDK (Rust transport in progress; see below)
  transcript/        — Isomorphic transcript rendering data layer
  i18n/              — Shared i18n infrastructure (t() with en/zh support)
  i18n-shared/       — Shared i18n core (types, locale detection, web-safe)
  telemetry/         — Shared client-side telemetry infrastructure
  minidb/            — Embedded key-value DB (Redis-style in-memory + SQLite-style WAL)
  migration-legacy/  — Data migration from kimi-cli (~/.kimi/) to kimi-code (~/.kimi-code/)
  pi-tui/            — Terminal UI framework (upstream dependency, node:test suite)
  kimi-native-tools/ — Rust native Node addon (napi-rs)
  kimi-build/        — Rust native build tool (SEA binary injection)
  kimi-agent/        — Rust agent engine — the only engine
  kimi-shared/       — Shared Rust single-source-of-truth crate (re-exported by kimi-native-tools / kimi-agent)
```

#### Key Package Details

**`agent-core`** — RETIRED (v1 engine). Physically moved to `retired/agent-core/` (2026-08-03). Hosts no longer reference it; do not extend. Superseded by `kimi-agent`.

**`agent-core-v2`** (v0.2.0) — Next-gen agent engine with DI × Scope architecture. FROZEN: the JS engine loop is retired and unreachable; kept only because `klient` still consumes its v2 dispatcher (being replaced by the Rust transport). Do not extend. Includes dependency graph analysis, domain layer linting, and contract type generation scripts.

**`kosong`** (v0.6.0) — The LLM / provider abstraction layer. Supports Anthropic, Google Gemini, and OpenAI-compatible providers. Uses `zod-to-json-schema` for tool schema conversion.

**`klient`** (v0.1.0) — Client SDK. A contract-driven facade with aggregated `global.*` / `session(id).*` / `agent(id).*` methods and zod validation on every call. The v2 dispatcher transport (ipc or memory) is being replaced by the Rust transport (⑤); once that lands, `agent-core-v2` moves to `retired/`.

**`transcript`** (v0.0.1) — Isomorphic transcript rendering data layer. Pure TypeScript (browser-safe). Agent-granular L1 store, idempotent L2 operations, granularity-gated L3 subscriptions (`off/turn/block/delta`), framework-free L4 view registry. Owns all transcript contract types in `src/contract/`.

**`kimi-native-tools`** — Rust native addon via napi-rs. Implements: bash execution, grep, glob, read, write, edit, token counting, output truncation, web fetching (HTML rendering via scraper), image processing, SSE/eventsource streaming, SQLite (rusqlite), ULID generation, and more. Cargo workspace, `cdylib` output.

**`kimi-build`** — Rust CLI tool for SEA (Single Executable Application) binary injection and asset management. Windows PE resource management via winapi.

**`minidb`** (v0.2.0) — Pure-Node.js embedded key-value database. Combines Redis-style in-memory KV with SQLite-style WAL + snapshot persistence. Includes cluster support.

### Plugins

```
plugins/
  marketplace.json   — Plugin marketplace manifest
  official/          — Official plugins
  cdn/               — CDN-distributed plugins (gitignored)
```

### Scripts

```
scripts/
  fix-node-pty-perms.mjs        — Postinstall: fix node-pty permissions
  generate-locale-json.cjs      — Generate locale JSON from translation source
  check-locale-keys.mjs         — Check locale key coverage
  check-locale-placeholders.cjs — Validate i18n placeholder consistency
  check-nix-workspace.mjs       — Validate flake.nix vs workspace membership
  check-service-naming.mjs      — Check service naming conventions
  check-t-call-coverage.mjs     — Check t() call coverage
  scan-hardcoded[-v2].mjs       — Scan for hardcoded strings (i18n compliance)
  prompt-optimizer/             — Prompt benchmark and optimization tools
```

---

## Environment Requirements

- **Node.js**: `>=24.15.0` (`.nvmrc` is `24.15.0`). `engine-strict=true` in `.npmrc` — `pnpm install` fails immediately if the Node version is not met.
- **pnpm**: `10.33.0` (specified in root `package.json` `packageManager`).
- **Rust** (optional, for native tools): Stable toolchain, MSVC on Windows.
- **Git for Windows** (Windows only): Required for runtime shell environment.

---

## Build & Test Commands

### Root-level commands

```sh
pnpm install                  # Install all dependencies
pnpm build                    # Build all workspace packages
pnpm build:packages           # Build only packages/*
pnpm dev:cli                  # Run CLI in dev mode
pnpm dev:web                  # Run web UI in dev mode
pnpm dev:server               # Run server in dev mode
pnpm test                     # Run all tests (vitest)
pnpm test:watch               # Watch mode
pnpm test:coverage            # With coverage
pnpm typecheck                # TypeScript check (builds packages first)
pnpm lint                     # oxlint --type-aware
pnpm lint:fix                 # Auto-fix
pnpm sherif                   # Monorepo correctness check
pnpm clean                    # Clean all dist directories
pnpm changeset                # Generate a changeset
pnpm version                  # Apply changesets (bump versions)
pnpm publish                  # Full publish pipeline
```

### Makefile targets

```sh
make prepare          # pnpm install
make build            # pnpm build
make typecheck        # Full typecheck
make lint             # oxlint
make test             # vitest
make rust-build       # cargo build --release -p kimi-build -p kimi-agent
make rust-check       # cargo check
make rust-test        # cargo test + kimi-agent --test
```

### Package-specific commands

```sh
# CLI app
pnpm --filter @moonshot-ai/kimi-code build
pnpm --filter @moonshot-ai/kimi-code run dev
pnpm --filter @moonshot-ai/kimi-code run test
pnpm --filter @moonshot-ai/kimi-code run e2e     # E2E tests (sets KIMI_E2E=1)

# Native tools (Rust)
cd packages/kimi-native-tools && cargo test
cd packages/kimi-native-tools && cargo build --release
pnpm --filter @moonshot-ai/kimi-code run build:native:release  # Full SEA build

# VS Code extension
pnpm --filter kimi-code run build
pnpm --filter kimi-code run test
pnpm --filter kimi-code run package:platform     # Produce .vsix

# Web UI
pnpm --filter @moonshot-ai/kimi-web run build
pnpm --filter @moonshot-ai/kimi-web run dev
```

### CI pipeline

GitHub Actions (`ci.yml`) runs on every PR and push to `main`:
1. **build** — Install, build, smoke test CLI bundle
2. **test** — `vitest run` split across 5 parallel shards on Ubuntu
3. **test-pi-tui** — `pi-tui` suite (uses node:test, not vitest)
4. **lint** — oxlint, sherif, locale JSON freshness check, locale placeholder validity, hardcoded string scan
5. **typecheck** — TypeScript check across all packages (uses `tsgo` from `@typescript/native-preview`)
6. **native-tools** — Runs on Windows-latest: `cargo test` and `cargo build --release`

Additional workflows: `_native-build.yml`, `docs-deploy.yml`, `manual-native-bundle.yml`, `nix-build.yml`, `pkg-pr-new.yml`, `pr-title-checker.yml`, `release.yml`.

---

## Code Style & Conventions

### Formatting (oxfmt)

- 2-space indentation, spaces not tabs
- 100 print width
- Single quotes, trailing commas, LF line endings
- Import sorting: builtin → external → internal → parent/sibling/index → unknown
- For full config, see `.oxfmtrc.json`

### Linting (oxlint)

- **Plugins**: typescript, import, unicorn, promise, node
- **Key rules**:
  - `eqeqeq: error`, `no-throw-literal: off`
  - `typescript/no-misused-promises: error`, `typescript/return-await: error`
  - `import/no-cycle: error`, `import/no-self-import: error`
  - `unicorn/prefer-node-protocol: error`
  - `no-console: warn`, `no-explicit-any: warn`, `no-non-null-assertion: warn`
  - `consistent-type-imports: warn`
- Test files get relaxed rules (no-explicit-any off, no-console off, vitest plugin rules)
- `packages/kosong/src/providers/` gets relaxed unsafety rules
- For full config with all overrides, see `.oxlintrc.json`
- Ignored: `dist/`, `coverage/`, `node_modules/`, `apps/*/scripts/`, `packages/pi-tui/`, `*.generated.ts`, `参考目录/`

### TypeScript Config (root `tsconfig.json`)

- **target**: ES2024
- **module**: preserve (bundler mode)
- **strict**: true
- **Additional strictness**: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`
- **JSX**: react-jsx (React 19)
- **noEmit**: true (tsdown handles bundling)
- **skipLibCheck**: true

### General Coding Rules

- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Prefer importing via `import ... from '#/...'` (subpath imports), which serves the same purpose as `import ... from '@/...'`.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it.

### i18n Conventions

- All user-facing strings must use `t()` calls from the i18n framework.
- Supported locales: `en` (English), `zh` (Chinese).
- Locale JSON must be regenerated after translation changes: `node scripts/generate-locale-json.cjs`.
- Run `node scripts/scan-hardcoded-v2.mjs` to find hardcoded strings that should be localized.
- Run `node scripts/check-locale-placeholders.cjs` to validate placeholder consistency.

---

## Testing Instructions

### Test Framework

- **vitest 4.1.4** for all TypeScript/JavaScript tests (root-level)
- **node:test** for `@moonshot-ai/pi-tui` (not part of vitest workspace)
- **cargo test** for Rust packages (`kimi-native-tools`)
- **Coverage**: v8 provider, reports in text + HTML

### Vitest Configuration

Defined in root `vitest.config.ts`. Projects:
```
packages/*
apps/kimi-code
apps/kimi-web
apps/kimi-inspect
apps/vis/server
apps/vis/web
apps/vscode
```

Coverage includes `packages/*/src/**/*.ts` and `apps/*/src/**/*.ts`, excludes test files and dist directories.

### Running tests

```sh
pnpm test                     # All vitest suites
pnpm test:watch               # Watch mode
pnpm test:coverage            # With coverage report
pnpm --filter <package> test  # Single package
pnpm --filter <package> vitest run -- --reporter=verbose  # Verbose mode
```

### Test file conventions

- Test files co-locate with source or in a `test/` directory under each package/app.
- Patterns: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `test/**/*.ts`
- E2E tests live in `apps/kimi-code/test/e2e/` and require `KIMI_E2E=1` env.

---

## Security Considerations

### Security Policy (see `SECURITY.md`)

- Only the latest released version receives security support.
- Report vulnerabilities via GitHub Security Advisories or email `code@moonshot.ai` with `[security]` in subject.
- Do not open public issues for security vulnerabilities.

### Hardened Dependencies

The monorepo enforces safe minimum versions for known-vulnerable packages via `pnpm.overrides`:
- `undici >= 7.28.0`, `shell-quote >= 1.8.4`, `dompurify >= 3.4.12`
- `tar >= 7.5.22`, `fast-uri >= 3.1.1`, `serialize-javascript >= 7.0.3`
- `hono >= 4.12.18`, `body-parser >= 2.3.0`, `ws >= 8.21.0`
- `js-yaml >= 4.2.0`, `vite >= 6.4.3`, `postcss >= 8.5.18`

Two dependencies are deliberately removed: `ssh2@1.17.0>cpu-features` and `ssh2@1.17.0>nan` are both overridden to `-` (skip installation).

### CI Security Checks

- Secret scanning via GitHub's built-in scan
- The `pkg-pr-new.yml` workflow publishes preview packages from PRs
- PR titles are enforced via `pr-title-checker.yml`

---

## Monorepo Workspace Maintenance

- **`pnpm-workspace.yaml`** is the source of truth for workspace membership (uses globs: `packages/*`, `apps/*`).
- **`flake.nix`** also contains hardcoded `workspacePaths` and `workspaceNames` lists that must be manually kept in sync.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix`** — for every package, including leaf / test / e2e packages that nothing depends on.
  - Missing a path in `flake.nix`'s `workspacePaths` silently drops files from the Nix build's `src` fileset.
  - Missing a name in `flake.nix`'s `workspaceNames` breaks `pnpmConfigHook`.
- **The automated check script** (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure slips through. Do not rely on the check to catch omissions.

---

## Version Management (Changesets)

- Every PR affecting release artifacts **must** include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `pnpm changeset` and follow the prompts.
- **Never** decide on a `major` bump on your own. When a change meets major criteria (breaking changes, incompatible user configuration, renamed/removed commands/arguments, changed behavior semantics), stop and ask the user for confirmation. Default to `minor` (fall back to `patch` if unclear).
- Base branch: `main`
- Ignored from versioning: `@moonshot-ai/vis`, `@moonshot-ai/vis-server`, `@moonshot-ai/vis-web`, `@moonshot-ai/kimi-inspect`

---

## Experimental Features

- Engine features: gate a not-yet-public feature behind an experimental flag defined in Rust — `packages/kimi-agent/src/config/types.rs` (e.g. the `secondary-model` flag, default off; enforcement in `config/native_llm.rs::resolve_secondary_native_llm`). Add `cargo test` coverage for both gated states.
- The legacy TS flag registry (`packages/agent-core/src/flags/registry.ts`) is retired together with `agent-core` — do not add flags there.

---

## Commit Convention (Conventional Commits)

| Type | Use for | Example |
|------|---------|---------|
| feat | A new feature | `feat(kimi-agent): add tool dedup` |
| fix | A bug fix | `fix(tui): correct status bar alignment` |
| docs | Documentation only | `docs: clarify install instructions` |
| chore | Tooling / housekeeping | `chore: bump dependencies` |
| refactor | Internal refactor without behavior change | `refactor(kosong): extract retry helper` |
| test | Adding or improving tests | `test(kimi-agent): cover skill resolver` |
| ci | CI / build pipeline changes | `ci: cache pnpm store` |
| build | Build system / artifact changes | `build(native): add win32-arm64 target` |
| perf | Performance improvement | `perf(session): batch event flushes` |
| style | Formatting only (no logic) | `style: apply oxlint --fix` |

PR titles are enforced by the `pr-title-checker` workflow.

---

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Working Principles

- **Engine-first rule**: agent engine functionality is written in **Rust**, never TypeScript. If the feature belongs to the engine domain (session loop, tools, context, goal, plan, permission, approvals, …), modify `packages/kimi-agent` (or `kimi-native-tools` / `kimi-shared`) and add `cargo test` coverage — even if an equivalent TS implementation already exists in `agent-core` / `agent-core-v2` (those are retired / frozen and must not be extended). See "Engine Ownership" above.
- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.
- 每次提交必须同步远程仓库。禁止只提交到本地而不推送。每次 `git commit` 之后必须立即执行 `git push`，确保本地和远程（`origin`）始终保持一致。任何分支上的工作（包括功能分支、修复分支、实验性分支）在提交后都应推送，避免本地代码丢失或远程仓库落后。

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`.
- When opening a PR, fill in `PULL_REQUEST_TEMPLATE.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill.
- Do not commit throwaway scratch or exploratory files. Never stage: handoff documents (`HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`), UI mockups (`*-designs.html`, `*-mockup.html`, `*-demo.html`), or any `.tmp/` content.