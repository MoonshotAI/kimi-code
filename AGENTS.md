# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. This file is the single source of truth for project-wide knowledge. Keep it focused on the project map, hard constraints, and workflow requirements — things every task needs to know.

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

- **Author**: Moonshot AI
- **License**: MIT
- **Homepage**: https://github.com/MoonshotAI/kimi-code
- **Version**: `@moonshot-ai/kimi-code` 0.29.1 (the main CLI app)

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
| Primary language | **TypeScript** 6.0.2 (strict mode) |
| Module system | ESM (`"type": "module"` in every package) |
| Runtime | **Node.js** >= 24.15.0 (`.nvmrc`: 24.15.0) |
| Native code | **Rust** (via napi-rs for Node addon, pure Rust CLI tools) |
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

## Project Structure

### Apps

```
apps/
  kimi-code/        — Main CLI / TUI application (entry point)
  kimi-web/         — Browser web UI (Vue 3 + Vite)
  vscode/           — VS Code extension (React 19 webview)
  kimi-inspect/     — Web inspector for kap-server /api/v1/debug RPC surface
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
    v2/               — V2 command implementation
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

Peer to the TUI. Vue 3 + Vite + vue-i18n; talks to the server over REST + WebSocket under `/api/v1`. It must not depend on `@moonshot-ai/agent-core` (wire types are re-implemented locally). Debug against the two engines via the root `pnpm dev:v2` scripts. See `apps/kimi-web/AGENTS.md`.

#### `apps/vscode` — VS Code Extension

Full-featured VS Code extension (`kimi-code` in marketplace). React 19 webview UI with TailwindCSS 4, communicates with the main kimi-code server over local REST/WS.

Key contributions:
- Sidebar webview panel
- Commands: `kimi.focusInput`, `kimi.insertMention`, `kimi.newConversation`, `kimi.showLogs`, etc.
- Settings: `kimi.yoloMode`, `kimi.autosave`, `kimi.editorContext`, etc.
- Packaging: vsix via `@vscode/vsce`, published to both VS Code Marketplace and OpenVSX

#### `apps/kimi-inspect` — Web Inspector

Web inspector for the kap-server `/api/v1/debug` RPC surface. Workspace/session browser, per-session chat, and Service panels. React 19 + Vite. Built on a `ProxyChannel` model similar to VS Code.

#### `apps/vis` — Session Visualizer

Debug visualization tool for kimi-code sessions. Composed of `vis/server` (backend) and `vis/web` (frontend). Sessions and replays can be inspected via a web UI.

### Packages

```
packages/
  agent-core/        — Unified agent engine (v1)
  agent-core-v2/     — Agent engine v2 (DI × Scope architecture)
  kosong/            — LLM / provider abstraction layer
  kaos/              — Execution environment & file/process abstractions
  klient/            — Client SDK (contract-driven facade over agent-core-v2)
  kap-server/        — Kimi Code local server (REST + WebSocket)
  server/            — Legacy local REST + WebSocket server
  acp-adapter/       — Agent Client Protocol adapter (public package)
  node-sdk/          — Public TypeScript SDK (@moonshot-ai/kimi-code-sdk)
  protocol/          — Shared REST + WS protocol schemas (Zod types)
  transcript/        — Isomorphic transcript rendering data layer
  i18n/              — Shared i18n infrastructure (t() with en/zh support)
  i18n-shared/       — Shared i18n core (types, locale detection, web-safe)
  oauth/             — Kimi OAuth and managed auth utilities
  telemetry/         — Shared client-side telemetry infrastructure
  minidb/            — Embedded key-value DB (Redis-style in-memory + SQLite-style WAL)
  migration-legacy/  — Data migration from kimi-cli (~/.kimi/) to kimi-code (~/.kimi-code/)
  pi-tui/            — Terminal UI framework (upstream dependency, node:test suite)
  kimi-native-tools/ — Rust native Node addon (napi-rs)
  kimi-build/        — Rust native build tool (SEA binary injection)
  kimi-agent/        — Rust agent engine (experimental)
  kosong/            — LLM provider abstraction
```

#### Key Package Details

**`agent-core`** (v0.15.6) — The unified agent engine. Includes Agent, Session, profile, skills, tools, plan, permission, background, records, the in-process DI service layer (`src/services/`), and other core capabilities. The `Agent` class must be usable on its own — the constructor must not force a `Session` instance. Key submodules: `agent/`, `config/`, `flags/`, `loop/`, `rpc/`, `session/`.

**`agent-core-v2`** (v0.2.0) — Next-gen agent engine with DI × Scope architecture. Service interfaces, DI containers, scope-bound session management. Consumed by `kap-server` and `klient`. Includes dependency graph analysis, domain layer linting, and contract type generation scripts.

**`kosong`** (v0.6.0) — The LLM / provider abstraction layer. Supports Anthropic, Google Gemini, and OpenAI-compatible providers. Uses `zod-to-json-schema` for tool schema conversion.

**`kaos`** (v0.1.6) — Execution environment abstraction. File system operations, process management, SSH execution via `ssh2`. Used by the tool execution system.

**`klient`** (v0.1.0) — Client SDK. A contract-driven facade over agent-core-v2 with aggregated `global.*` / `session(id).*` / `agent(id).*` methods, zod validation on every call, and transport abstraction (ipc or memory). Also hosts e2e suites.

**`kap-server`** — The Kimi Code local server. Backed by DI × Scope agent engine. Exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`). Debug surface at `/api/v1/debug/*`. Bootstrapped from `src/start.ts`.

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

- Gate a not-yet-public feature behind an experimental flag. Add the flag to the registry at `packages/agent-core/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`.
- Flags are env-driven and default off:
  - `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one
  - `KIMI_CODE_EXPERIMENTAL_FLAG` enables all
- Release by flipping the entry's `default` to `true`.

---

## Commit Convention (Conventional Commits)

| Type | Use for | Example |
|------|---------|---------|
| feat | A new feature | `feat(agent-core): add tool dedup` |
| fix | A bug fix | `fix(tui): correct status bar alignment` |
| docs | Documentation only | `docs: clarify install instructions` |
| chore | Tooling / housekeeping | `chore: bump dependencies` |
| refactor | Internal refactor without behavior change | `refactor(kosong): extract retry helper` |
| test | Adding or improving tests | `test(agent-core): cover skill resolver` |
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