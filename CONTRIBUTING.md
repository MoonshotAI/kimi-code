# Contributing to kimi-code

Thanks for taking the time to contribute! This project moves quickly, and thoughtful contributions from the community are what keep it sharp. The guide below walks you through how we work so your PR has the best chance of landing smoothly.

## Before You Start

Kimi Code already has opinions on CLI/TUI behavior, agent workflows, and public APIs. If your change shifts that direction, open an issue first so we can align before you invest time in a PR.

We hold AI-assisted contributions to the same standard as hand-written ones. **You should understand what you submit** — what changed, how it behaves at the edges, and why it fits this codebase. If you cannot explain that, the PR is not ready for review.

We only merge PRs aligned with the roadmap. Drive-by refactors without context are unlikely to land.

**Discuss first** — open an issue before coding. PRs without prior discussion may be closed without review:

- New features or user-visible behavior changes (regardless of size)
- Refactors or other changes larger than ~100 lines
- Public API or compatibility changes
- Bug fixes where the cause or fix approach is still unclear

**Can open a PR directly** — link an existing issue when there is one:

- Clear, reproducible bug fixes with a focused diff
- Typos, documentation-only changes, and small CI/build fixes
- Small changes that clearly match an existing issue or maintainer request

## Project Layout

This is a pnpm monorepo. The most relevant entry points are:

- `apps/kimi-code` — CLI / TUI
- `apps/vis` — session replay & debugging visualizer
- `packages/node-sdk` — public TypeScript SDK (`@moonshot-ai/kimi-code-sdk`)
- `packages/agent-core`, `kosong`, `kaos`, `oauth`, `telemetry` — internal engine packages
- `docs/` — VitePress bilingual docs site

For the full project map, see [AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, pnpm 10.33.0, Git.

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

Useful scripts:

- `pnpm dev:cli` — run the CLI in dev mode
- `pnpm test` — run tests (vitest)
- `pnpm typecheck` — TypeScript check (note: builds packages first)
- `pnpm lint` — oxlint
- `pnpm lint:fix` — oxlint with auto-fix
- `pnpm build` — build all packages

## Build & Local Deploy

After making changes, build the full project:

```sh
pnpm build
```

If you only changed code under `apps/kimi-code`, you can build just that package:

```sh
pnpm --filter @moonshot-ai/kimi-code run build
```

This produces:

| Output | Path |
|--------|------|
| CLI entry (ESM) | `apps/kimi-code/dist/main.mjs` |
| Web UI assets | `apps/kimi-code/dist-web/` |
| Native prebuilds | `apps/kimi-code/native/` |

### Deploy to local `.kimi-code` for testing

To run your local build instead of the released binary:

1. **Sync dist files** to the Kimi Code home directory:

```powershell
# Remove old dist
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist" -ErrorAction SilentlyContinue
# Create fresh directory and copy contents
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.kimi-code\dist"
Copy-Item -Recurse -Force apps/kimi-code/dist/* "$env:USERPROFILE\.kimi-code\dist\"

# Sync web assets
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist-web" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force apps/kimi-code/dist-web "$env:USERPROFILE\.kimi-code\dist-web"
```

2. **Copy native `.node` files** into `dist/chunks/` (the ESM bundle resolves relative requires from chunk files):

```powershell
Copy-Item -Force packages/kimi-native-tools/kimi-native-tools.win32-x64-msvc.node `
    "$env:USERPROFILE\.kimi-code\dist\chunks\"
Copy-Item -Force packages/kimi-native-tools/kimi_native_tools.win32-x64-msvc.node `
    "$env:USERPROFILE\.kimi-code\dist\chunks\"
```

3. **Run with locale** (set `KIMI_LANG=zh` for Chinese interface):

```powershell
$env:KIMI_LANG="zh"
node $env:USERPROFILE\.kimi-code\dist\main.mjs
```

To make `kimi` command use the local build, rename the CDN binary and create a launcher:

```powershell
Rename-Item "$env:USERPROFILE\.kimi-code\bin\kimi.exe" "kimi.cdn.exe"
```

Create `$env:USERPROFILE\.kimi-code\bin\kimi.cmd`:

```bat
@echo off
setlocal
if "%KIMI_LANG%"=="" (
    for /f "tokens=2 delims== " %%a in (
        'type "%USERPROFILE%\.kimi-code\tui.toml" 2^>nul ^| findstr /r "^locale"'
    ) do set KIMI_LANG=%%~a
)
set KIMI_CODE_HOME=%USERPROFILE%\.kimi-code
node "%KIMI_CODE_HOME%\dist\main.mjs" %*
```

### Native SEA build (self-contained `.exe`)

The native build produces a standalone executable using Node.js Single Executable Applications. Requires Rust toolchain (MSVC on Windows).

```sh
pnpm --filter @moonshot-ai/kimi-code run build:native:release
```

Output: `apps/kimi-code/dist-native/bin/win32-x64/kimi.exe`

> **Note**: The SEA build currently requires `@moonshot-ai/kimi-native-tools` listed as a dependency in `apps/kimi-code/package.json` and registered in `apps/kimi-code/scripts/native/native-deps.mjs`. See [Common Issues](#common-issues) for known pitfalls.

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module '@moonshot-ai/i18n-shared'` | Workspace link broken; `pnpm install` hasn't re-linked after adding packages | Run `pnpm install` |
| `ERR_MODULE_NOT_FOUND` pointing to `src/index.ts` in `.kimi-code/node_modules` | Deployed package.json exports still point to source files | Edit exports to point to `dist/*.mjs` |
| `Failed to load kimi-native-tools binding` | `.node` files missing from `dist/chunks/` (the ESM bundle resolves from chunk directory) | Copy `.node` files directly into `dist/chunks/` |
| `ERR_UNKNOWN_BUILTIN_MODULE: @moonshot-ai/kimi-native-tools` in SEA binary | Native module not registered in `native-deps.mjs` | Add entry to `nativeDeps` array with `collect: 'native-files'` |
| `packages/i18n-shared` build fails with `UNRESOLVED_ENTRY` | Missing `src/index.ts` | Create `src/index.ts` re-exporting types, core, and detect modules |
| `kimi.exe` from CDN shows English despite `locale=zh` | The CDN binary includes only the bundled locale; download date determines version | Build locally or wait for next CDN release |

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core): add tool dedup          |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(kosong): extract retry helper    |
| test     | Adding or improving tests                   | test(agent-core): cover skill resolver    |
| ci       | CI / build pipeline changes                 | ci: cache pnpm store                      |
| build    | Build system / artifact changes             | build(native): add win32-arm64 target     |
| perf     | Performance improvement                     | perf(session): batch event flushes        |
| style    | Formatting only (no logic)                  | style: apply oxlint --fix                 |

PR titles are enforced by the `pr-title-checker` workflow — a non-conforming title will block merge.

## Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage versioning and releases.

- Every PR that affects release artifacts (code, behavior, public API) **must** include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `pnpm changeset` and follow the prompts (which packages are touched, which bump level).
- For repo-specific conventions on package selection and bump levels, see `.changeset/README.md`. When working in this repo with coding agents, use the `gen-changesets` skill.

## Pull Requests

Use the [PR template](.github/pull_request_template.md) when opening a feature pull request.

PR titles must follow [Conventional Commits](#commit-convention); CI runs `pnpm lint`, `pnpm typecheck`, and `pnpm test` on every PR. Update user-facing docs in `docs/` when behavior changes — use the `gen-docs` skill when working with coding agents.

## Code Style

- TypeScript across the codebase.
- Linting via `oxlint` (config in `.oxlintrc.json`).
- Auto-formatting via `pnpm lint:fix`.
- Follow existing local patterns when the lint rules do not cover a style choice.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
