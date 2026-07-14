# Repository-level Agent Guide

Reply in the same language as the user.

This is the **Kimi Code CLI** monorepo (public repo: `MoonshotAI/kimi-code`) — a pnpm + TypeScript monorepo that builds an AI coding agent for the terminal, plus its web UI, desktop shell, server, and debugging tools. It is built for agent-assisted development. Keep this root file limited to hot-path knowledge: the project map, hard constraints, build/test/release commands, and workflow rules. Directory-specific rules live in nested `AGENTS.md` files — always follow the nearest one in the tree.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## The Two-Engine Reality (read this first)

The single most important architectural fact: **two generations of the agent engine coexist**.

- `packages/agent-core` ("v1", `@moonshot-ai/agent-core`): the original class-based engine (Agent, Session, loop, tools, skills, permissions, goal mode, compaction, MCP, plugins, plus a VS Code-style in-process DI service layer under `src/services/`). Still powers `kimi -p` (print mode), `kimi acp`, and `apps/vis` — via `packages/node-sdk` (`@moonshot-ai/kimi-code-sdk`), `packages/acp-adapter`, and `apps/vis/server`. v1 depends on `kosong` (LLM abstraction) and `kaos` (execution environment).
- `packages/agent-core-v2` ("v2", `@moonshot-ai/agent-core-v2`): a work-in-progress port of v1 to a **DI × Scope** architecture (`LifecycleScope { App, Session, Agent }`, services registered with `registerScopedService`, source organized by scope under `src/_base`, `src/app/`, `src/session/`, `src/agent/`, plus `src/os/` and `src/persistence/` interface+backends layers). It is the **current engine for the interactive TUI and the server**: `packages/kap-server` (Fastify, `/api/v1` REST+WS compat plus native `/api/v2` RPC) runs on v2, and `apps/kimi-code`'s TUI reaches v2 through the in-app facade `src/core/` (`CoreHarness`/`CoreSession`). v2 vendors its own LLM wire layer (`app/llmProtocol`, using `@anthropic-ai/sdk` / `@google/genai` / `openai` directly) and does **not** depend on v1, `kosong`, or `kaos` — enforced by `pnpm --filter @moonshot-ai/agent-core-v2 lint:domain`.
- Current migration phase: v2 parity/bug-fixing against v1 (see the many `.changeset/fix-v2-*.md` entries). The old v1 `packages/server` was deleted; the `packages/server/` directory in the working tree is only untracked build residue (`dist/`, `node_modules/`) — never edit or reference it.

When working on engine behavior, first decide which engine the code path actually uses (TUI/server → v2; print/ACP/vis → v1), then read that engine's local guide: `packages/agent-core-v2/AGENTS.md` or `packages/agent-core/src/services/AGENTS.md`.

## Environment Requirements

- **Node.js**: `>=24.15.0` (root `package.json` `engines`; `.nvmrc` pins `24.15.0`). `.npmrc` sets `engine-strict=true`, so `pnpm install` fails on older Node. The native SEA build also hard-requires Node ≥ 24.15.
- **pnpm**: `10.33.0` (root `packageManager`). Workspaces: `packages/*`, `apps/*`, `apps/vis/server`, `apps/vis/web`, `docs` (`pnpm-workspace.yaml`).
- Toolchain pinned at the root: TypeScript `6.0.2`, tsdown `0.22.0`, vitest `4.1.4`, oxlint `1.59.0`.

## Project Map

Apps:

- `apps/kimi-code` (`@moonshot-ai/kimi-code`, the only public npm package): the CLI / TUI, `bin: kimi`. Entry chain: `src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → `src/core` `CoreHarness` → `src/tui/kimi-tui.ts`. Contains the CLI/subcommands (`src/cli/`, incl. `server`, `acp`, `login`, `doctor`, `upgrade`, self-update), the v2 facade (`src/core/`), the TUI (`src/tui/`, built on `packages/pi-tui`), and the Node SEA single-binary build (`scripts/native/`, `src/native/`). See `apps/kimi-code/AGENTS.md`; use the `write-tui` skill for any TUI work.
- `apps/kimi-web` (`@moonshot-ai/kimi-web`): the browser web UI, a peer to the TUI. Vue 3 + Vite + vue-i18n, zero workspace dependencies (wire types re-implemented locally in `src/api/daemon/wire.ts`); talks to kap-server over REST + WebSocket `/api/v1`. Its `dist/` is copied into the CLI (`dist-web/`) and shipped inside the npm package and the SEA blob. See `apps/kimi-web/AGENTS.md`.
- `apps/kimi-desktop` (`@moonshot-ai/kimi-desktop`): Electron 33 shell + process manager around the web UI; launches the shared SEA `server run` daemon and loads the web UI from it. No runtime/workspace dependencies; coupling to `apps/kimi-code` is the built SEA binary. No test script.
- `apps/vis` (+ `apps/vis/server`, `apps/vis/web`): session/replay visual debugging tool, embedded in the CLI as `kimi vis`. vis-server is Hono on top of v1 `agent-core`; vis-web is React 19 + Tailwind 4. These packages are ignored by changesets.

Engine and server packages:

- `packages/agent-core` — v1 engine (see "The Two-Engine Reality"). Tests: vitest project `kimi-core`, `test/**/*.{test,e2e}.ts`.
- `packages/agent-core-v2` — v2 engine (DI × Scope). Tests: vitest project `agent-core-v2`, `test/` mirrors `src/` domains, with `test/harness/`. Extra scripts: `lint:domain` (layering + v1-import ban), `gen:contract-types`, `dep-graph:*`. See `packages/agent-core-v2/AGENTS.md` and its `docs/` (`di.md`, `service-design.md`, `flag.md`, `errors.md`, `di-testing.md`) before adding capabilities.
- `packages/kap-server` (`@moonshot-ai/kap-server`): the Kimi Code server on v2. Fastify 5; `/api/v1` REST + WS (compat) and `/api/v2` RPC + WS (native, VS Code-style channel model). Entry `src/start.ts`; also OS service management (`src/svc/`), single-instance lock, multi-instance registry, token rotation. Started by `kimi server run`; default port 58627.
- `packages/klient`: `/api/v2` client SDK — reuses agent-core-v2 service interfaces over HTTP/WS channels ("the shared interface is the whole contract").
- `packages/protocol`: shared REST + WS protocol zod schemas for the daemon, plus AsyncAPI generation. Tests live in `src/__tests__/`.
- `packages/minidb`: dependency-free embedded KV store (WAL + snapshots + skiplist indexes + optional RESP server); v2's persistence backend.
- `packages/server-e2e`: wire-level e2e against a **running** server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`); HTTP/WS test clients, `scenarios/*.ts` (`test:scenarios`), v2 smoke test that boots kap-server in-process, and `docker:e2e`. Live cases skip when no server is up. See `packages/server-e2e/AGENTS.md` — existing v1 tests must keep running unchanged.

Foundation packages:

- `packages/kosong`: v1's LLM/provider abstraction (message types, `ChatProvider`, `generate()`, tool wire schema, model catalog; providers under `@moonshot-ai/kosong/providers/*`).
- `packages/kaos`: v1's execution-environment abstraction ("Kimi Agent Operating System") — one `Kaos` interface for path/file/process ops across local/SSH (`LocalKaos`, `SSHKaos`).
- `packages/oauth` (`@moonshot-ai/kimi-code-oauth`): Kimi OAuth device-code flow, token storage with file locking, managed-config provisioning, open-platform registry.
- `packages/telemetry` (`@moonshot-ai/kimi-telemetry`): shared client telemetry (queue, sinks, crash handlers, system metrics).
- `packages/node-sdk` (`@moonshot-ai/kimi-code-sdk`): the public v1 SDK/harness (`KimiHarness`, `Session`, auth facade, RPC). Bundles agent-core/kaos/kosong/oauth into its `dist` via tsdown + API Extractor (single `index.d.mts`). Currently `private: true` — not published.
- `packages/acp-adapter`: Agent Client Protocol adapter — exposes a v1 harness as an ACP JSON-RPC server over stdio for editors/IDEs (`kimi acp`).
- `packages/pi-tui`: vendored fork of the upstream `pi-tui` differential-rendering TUI framework (do not overwrite wholesale from upstream — local divergences have guard tests). **Tests run with `node --test`, not vitest.** See `packages/pi-tui/AGENTS.md`.
- `packages/migration-legacy`: migrates `~/.kimi/` (kimi-cli) data into `~/.kimi-code/`; consumed by the CLI's startup migration UI.

Other notable locations:

- `docs/`: VitePress bilingual (`en`/`zh`) user documentation site. Keep locales in sync; see `docs/AGENTS.md` and the `translate-docs` / `gen-docs` skills.
- `plugins/`: bundled plugin marketplace — `marketplace.json` + `official/kimi-datasource`. Ships via CDN (`pnpm build:plugin-marketplace`), **not** the npm package; plugin changes need no changeset.
- `.agents/skills/`: repo skills — `write-tui`, `gen-changesets`, `gen-docs`, `agent-core-dev`, `agent-core-review`, `translate-docs`, `sync-changelog`, `pre-changelog`. Use them when the task matches.
- `GOAL.md`: committed design doc for goal mode (Chinese).
- Package-internal convention: workspace `exports` point at `./src/*.ts` (packages consume each other's TypeScript source, not `dist`), and most packages use the `imports: { "#/*": "./src/*.ts" }` alias.

## Build, Test, and Quality Commands

Run from the repo root unless noted (the `Makefile` wraps the same pnpm scripts):

- `pnpm install` — setup (runs `scripts/fix-node-pty-perms.mjs` postinstall).
- `pnpm build` — build all packages recursively; `pnpm build:packages` — only `packages/*`.
- `pnpm test` — `vitest run` across the root projects (`packages/*` + `apps/kimi-code`, see `vitest.config.ts`). `pnpm test:coverage` for v8 coverage.
- `pnpm typecheck` — builds packages first, then runs each package's `typecheck` plus the app typechecks (`kimi-code`, `kimi-web`, `vis-server`, `vis-web`, `kimi-desktop`).
- `pnpm lint` / `pnpm lint:fix` — oxlint `--type-aware` (config `.oxlintrc.json`). `pnpm sherif` — monorepo dependency-consistency check. `pnpm lint:pkg` — publint + attw on the CLI package.
- Scoped tests: `pnpm --filter <pkg> test`, or `pnpm vitest run --project <name>` (project names: `kimi-core`, `agent-core-v2`, `kap-server`, `klient`, `protocol`, `minidb`, `migration-legacy`, `server-e2e`, `kosong`, `kaos`, `kimi-oauth`, `kimi-telemetry`, `kimi-sdk`, `acp-adapter`, `cli`, ...). Note: `packages/pi-tui` uses `node --test` (`pnpm --filter @moonshot-ai/pi-tui test`) and is not executed by root `vitest run`; `apps/kimi-web` / `apps/vis/*` tests only run via their own scoped `test` scripts, not via root `pnpm test`.
- Dev entry points: `pnpm dev:cli` (CLI via tsx, with a local plugin-marketplace dev server), `pnpm dev:server` (kap-server in foreground on 58627), `pnpm dev:v2` (second kap-server instance on 58628 with `KIMI_CODE_EXPERIMENTAL_MULTI_SERVER=1`), `pnpm dev:web` (kimi-web Vite dev server; its Sidebar can switch the proxied backend between the two servers at runtime), `pnpm dev:desktop`, `pnpm vis`, `pnpm dev:docs`.

Native single-binary build (in `apps/kimi-code`, Node SEA; targets darwin/linux/win32 × arm64/x64): `build:native:js` (tsdown CJS bundle + self-containment check) → `build:native:sea` (SEA config → blob → postject inject → sign → verify) → `package:native` (zip + sha256); `test:native:smoke` validates the injected binary in an isolated HOME.

## Testing Instructions

- Framework: vitest 4 in projects mode; test files are `*.test.ts` (plus `*.e2e.test.ts` / `*.integration.test.ts` where present), located in each package's `test/` directory mirroring `src/` — except `packages/protocol` (`src/__tests__/`) and `packages/pi-tui` (`node --test`).
- **Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.**
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- CLI e2e: `pnpm -C apps/kimi-code run e2e` (`KIMI_E2E=1`) and `e2e:real` (`KIMI_E2E_REAL=1`, hits a real LLM). `test/e2e/smoke-checklist.md` is the manual full-regression checklist for the v2 engine.
- Server e2e: start `pnpm dev:server` first, then `pnpm --filter @moonshot-ai/server-e2e test` (or `test:scenarios`); without a server, live cases skip.
- Some packages (`apps/kimi-code`, `kap-server`, `server-e2e`) need `build/raw-text-plugin.mjs` in their vitest config because the agent-core-v2 barrel imports `*.md?raw`.
- Verify before claiming done: run the checks that cover your change (scoped test at minimum; `pnpm lint` and `pnpm typecheck` for anything cross-cutting) and look at the result.

## Code Style Guidelines

- TypeScript everywhere, ESM (`"type": "module"`), strict mode with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (root `tsconfig.json`; per-package configs extend it).
- Lint: oxlint — `eqeqeq`, `no-misused-promises`, `return-await`, `only-throw-error`, `import/no-cycle`, `unicorn/prefer-node-protocol` are errors; vitest plugin rules apply to test files. Formatting conventions live in `.oxfmtrc.json` (print width 100, 2-space, single quotes, trailing commas, sorted imports) and `.editorconfig` (LF, 2-space, final newline); `lint-staged` runs oxlint on staged files.
- Prefer importing via `import ... from '#/...'` (same purpose as `@/...`).
- For optional object properties, pass `undefined` directly instead of conditional spread: YES `{ user }`, NO `{ ...(user ? { user } : undefined) }`. Optional properties do not need `| undefined` in the type.
- Internal methods with a single parameter should not be turned into options objects for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- The `Agent` class in `packages/agent-core/src/agent` must be usable on its own: the constructor must not force a `Session`, `agentId`, or `session`; an optional `sessionId` request-config hint (e.g. provider `prompt_cache_key`) is allowed, but the instance must not hold it or depend on Session lifecycle logic.
- v2 (`agent-core-v2`) local rules: comments live solely in the top-of-file `/** */` block; business events go through `ITelemetryService.track2` with events registered in `src/app/telemetry/events.ts`; business domains never implement persistence themselves (no `node:fs`, SQL, or hand-rolled append-logs — use the `IAppendLogStore` / `IAtomicDocumentStore` / `IBlobStore` contracts). Details in `packages/agent-core-v2/AGENTS.md`.
- TUI (`apps/kimi-code`) local rules: the TUI reaches the engine only through `src/core/`; `theme` is the single source of truth for colors (chalk named colors are forbidden and guard-tested); `handleInput` printable-key comparisons must go through `printableChar(data)`. Details in `apps/kimi-code/AGENTS.md`.

## Experimental Features

- Gate not-yet-public features behind an experimental flag. v1: add the flag to `packages/agent-core/src/flags/registry.ts` and check with `flags.enabled('my-feature')`. v2: the `app/flag` domain (`registerFlagDefinition` + `IFlagService`, see `packages/agent-core-v2/docs/flag.md`). Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.

## Monorepo Workspace Maintenance

- `pnpm-workspace.yaml` is the source of truth for workspace membership, but `flake.nix` also contains **hardcoded** `workspacePaths` and `workspaceNames` lists.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix` — for every package, including leaf / test / e2e packages that nothing depends on.** `pnpm-workspace.yaml` uses globs so most packages land there automatically; `flake.nix` is fully manual and is where omissions happen. Missing a path silently drops files from the Nix build's `src` fileset; missing a name breaks `pnpmConfigHook` dependency fetching.
- The automated check (`scripts/check-nix-workspace.mjs`, run by the `nix-build.yml` workflow) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure slips through even when missing from `flake.nix` — a green check is NOT proof of full sync.

## Changesets and Release

- Versioning uses [changesets](https://github.com/changesets/changesets) (config `.changeset/config.json`, conventions `.changeset/README.md`). Every PR that affects release artifacts (code, behavior, public API) must include a changeset; docs-only / test-only / CI-only PRs may skip.
- **After finishing a task and before submitting a PR, run the `gen-changesets` skill (`.agents/skills/gen-changesets/SKILL.md`)** and generate the changeset under `.changeset/` per its rules. Key points: the only user-facing published package today is `@moonshot-ai/kimi-code` — all internal packages are bundled into it, so user-visible changes in any internal package (including `apps/kimi-web`, which ships inside the CLI bundle) must list `@moonshot-ai/kimi-code` in the changeset frontmatter; entries are one English sentence, no file/class names or internal endpoints.
- **Never decide on a `major` bump on your own.** If a change meets the major criteria (breaking changes, incompatible user configuration, renamed/removed commands or arguments, changed behavior semantics), stop and ask the user for confirmation first. Otherwise default to `minor` (fall back to `patch` if unclear).
- Release pipeline (`.github/workflows/release.yml`, on push to `main`): unconsumed changesets → `changesets/action` opens a release PR (`ci: release packages`, runs `changeset version`) → merging it publishes to npm via OIDC Trusted Publishing → docs deploy to GitHub Pages → if the CLI was published, six-platform signed SEA binaries and desktop installers are built and uploaded to the GitHub Release with an aggregated `manifest.json` consumed by the install scripts.

## CI Pipeline (`.github/workflows/`)

- `ci.yml` (PRs + push to main): build + CLI bundle smoke test; vitest sharded 5 ways; separate `test-pi-tui` job (`node --test`); oxlint + sherif; typecheck via `tsgo` for packages/CLI and `vue-tsc` for the Vue apps. The Windows test job is temporarily disabled (`if: false`).
- `nix-build.yml`: flake workspace-sync check + `nix build .#kimi-code`, with bot comments on failure.
- `pr-title-checker.yml`: enforces Conventional Commit PR titles (`feat|fix|test|refactor|chore|style|docs|perf|build|ci|revert`), labels non-conforming PRs `Invalid PR Title`.
- `pkg-pr-new.yml`: publishes a per-PR preview install of the CLI.
- `release.yml`, `_native-build.yml`, `desktop-build.yml`, `manual-native-bundle.yml`, `docs-deploy.yml`: the release/artifact pipeline described above.

## Security Considerations

- Report vulnerabilities per `SECURITY.md`, never as public issues.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- Never commit credentials, tokens, or secret-bearing files. kap-server enforces auth middleware, origin checks, rate limits, and bind classification (`lan`/`public`) — keep those paths intact when touching server code; non-loopback bindings in vis-server require `VIS_AUTH_TOKEN`.
- Telemetry must never include user content or paths (v2: only pre-registered snake_case events via `track2`).

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- When creating a PR, the title must follow Conventional Commit style (e.g. `chore: remove legacy format commands`), and the description must fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic diff summary; the human author must be able to explain the change, its edge cases, and why the approach fits this repository. CONTRIBUTING.md requires opening an issue first for features, >100-line changes, and public API changes.
- Update user-facing docs in `docs/` when behavior changes (use the `gen-docs` skill; keep `en`/`zh` in sync per `docs/AGENTS.md`).
- Do not commit throwaway scratch or exploratory files. Never stage agent working notes or handoff documents (e.g. `HANDOVER-*.md`, `handoff.md`) or throwaway UI prototypes (e.g. `*-mockup.html`, `*-demo.html`) — the only tracked `.html` files should be Vite `index.html` entrypoints. Put scratch work under `.tmp/` (gitignored). Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns.

## Where to Update Instructions

- Hard rules that affect almost every task: update this root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md` (`apps/kimi-code`, `apps/kimi-web`, `docs`, `packages/agent-core-v2`, `packages/agent-core/src/services`, `packages/pi-tui`, `packages/server-e2e`).
- Keep instruction updates focused and supported by code facts; when conventions documented here change in code, update this file in the same change.
