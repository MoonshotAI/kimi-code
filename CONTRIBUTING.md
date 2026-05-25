# Contributing to kimi-code

Thanks for taking the time to contribute! This project moves quickly, and thoughtful contributions from the community are what keep it sharp. The guide below walks you through how we work so your PR has the best chance of landing smoothly.

## Before You Start

- Open an issue or discussion before making changes larger than ~100 lines so we can align on direction early.
- We only merge PRs that are aligned with the roadmap — drive-by refactors without context are unlikely to land.
- Code quality bar: as good as code written by a strong human engineer or a competent coding agent. We hold AI-assisted contributions to the same standard as hand-written ones.
- You must understand the code you submit. If you cannot explain what changed, how it behaves at the edges, and why it fits this codebase, the PR is not ready for review.

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
- For repo-specific conventions, see `.changeset/README.md`.

## Pull Request Checklist

Before requesting review, make sure your PR ticks the following:

- [ ] Linked an issue (for non-trivial changes)
- [ ] PR title follows Conventional Commits
- [ ] Added or updated tests
- [ ] Added a changeset if the PR affects release artifacts
- [ ] Ran `pnpm lint && pnpm typecheck && pnpm test` locally
- [ ] Updated user-facing docs in `docs/` if behavior changed

The `.github/pull_request_template.md` checklist is a shorter subset of this — both must pass.

## Pull Request Description

Review time is limited, and AI tools can generate changes much faster than maintainers can review them. A PR description should make the change easy to evaluate, not just summarize the diff.

Every non-trivial PR should clearly explain:

- Problem: what user-visible bug, limitation, or need this PR addresses.
- Cause: for bug fixes, why the problem happened. Point to the relevant code path when possible.
- Solution: what changed and why this approach fits the existing design.
- Behavior: what users, CLI output, docs, APIs, or compatibility guarantees are affected.
- Verification: which tests, checks, or manual steps you ran, with enough detail for reviewers to trust the result.
- Release notes: whether docs and changesets were updated, or why they are not needed.

AI-assisted PRs are welcome only when a human has reviewed, edited, tested, and understood the result. Do not submit bulk generated code, generic PR text, or tests that do not prove the behavior.

## Code Style

- TypeScript across the codebase.
- Linting via `oxlint` (config in `.oxlintrc.json`).
- Auto-formatting via `pnpm lint:fix`.
- Follow existing local patterns when the lint rules do not cover a style choice.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
