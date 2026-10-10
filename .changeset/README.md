# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to manage npm package versions and releases.

## Package Publishing Strategy

This repository uses an **independent, manually-selected publishing** strategy. When generating a changeset, only select the publishable packages that this change actually affects. The repository's `.changeset/config.json` already filters out internal workspace packages via `ignore`, so only the publishable packages listed below should appear in the `pnpm changeset` prompt.

Current publishable packages:

| Package | Directory | Description |
| --- | --- | --- |
| `@moonshot-ai/kimi-code` | `apps/kimi-code` | CLI / TUI application — provides the `kimi` command after install |
| `@moonshot-ai/kimi-code-sdk` | `packages/node-sdk` | Public TypeScript SDK |

All other workspace packages are private internal packages, are not published to npm, and are excluded via `ignore` in `.changeset/config.json`:

- `@moonshot-ai/kaos`
- `@moonshot-ai/kimi-code-oauth`
- `@moonshot-ai/kimi-telemetry`
- `@moonshot-ai/kosong`
- `@moonshot-ai/migration-legacy`
- `@moonshot-ai/vis`
- `@moonshot-ai/vis-server`
- `@moonshot-ai/vis-web`

Version impact from internal dependencies must be judged manually. The published artifacts for CLI and SDK bundle internal workspace packages into the artifact itself; runtime `dependencies` of published packages must not include any `@moonshot-ai/*` internal workspace packages.

The repository's `.changeset/config.json` sets `updateInternalDependencies: "patch"`. Because internal packages are not published, you still need to manually select all affected publishable packages in the changeset — do not rely solely on automatic dependency bumps to express user-visible changes.

Example scenarios:

| Change | Changeset selection |
| --- | --- |
| Only modifies TUI behavior in `@moonshot-ai/kimi-code` | Add `patch` / `minor` / `major` to `@moonshot-ai/kimi-code` |
| Only modifies internal packages, no user-visible change in SDK / CLI | Usually no changeset needed |
| Internal package fix changes the CLI user experience | Add a changeset to `@moonshot-ai/kimi-code` describing the user-visible fix |
| Internal package adds a new capability exposed by the SDK | Add a changeset to `@moonshot-ai/kimi-code-sdk` |
| SDK behavior change affects CLI user experience | Add changesets to both `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/kimi-code` |
| Provider abstraction change affects SDK / CLI | Add changesets to the affected `@moonshot-ai/kimi-code-sdk` and/or `@moonshot-ai/kimi-code` |
| Test-only, internal refactor, docs, or private debug tooling changes | Usually no changeset needed |
| Bundled official plugin change under `plugins/` (e.g. `kimi-datasource`) | No changeset — the plugin is versioned via its own `kimi.plugin.json` / `plugins/marketplace.json` and shipped through the marketplace CDN, not the npm package |

## Prerequisite: NPM Trusted Publishing (OIDC)

This repository uses npm's **Trusted Publishing** (OIDC-based) for publishing — no `NPM_TOKEN` is required.

### Configuration steps

1. Open each publishable package's page on the npm website, e.g. `https://www.npmjs.com/package/@moonshot-ai/kimi-code`.
2. Go to **Settings** -> **Publishing access**.
3. Find **Automate publishing with GitHub Actions** or **Add trusted publisher**.
4. Click **Add a new trusted publisher**.

Fill in the following:

| Field | Value |
| --- | --- |
| GitHub Organization | `MoonshotAI` |
| GitHub Repository | `kimi-code` |
| GitHub Workflow | `release.yml` |
| Environment | leave empty |

Each publishable package needs its Trusted Publisher configured once. The current GitHub Actions workflow lives at `.github/workflows/release.yml` and already has `id-token: write` configured.

## Development Workflow

### 1. Implement the feature or fix

Complete code, tests, and documentation changes as usual. A changeset is required when the change affects user-visible behavior, public API, dependency ranges, or release artifacts of a publishable package.

### 2. Generate a changeset

From the repository root:

```sh
pnpm changeset
```

Follow the prompts to choose:

- Which publishable packages this change affects;
- The version bump level:
  - `patch`: bug fixes, small changes, follow-up dependency updates;
  - `minor`: backward-compatible new features;
  - `major`: breaking changes;
- A user-facing description of the change.

The command creates a `.changeset/*.md` file that must be committed alongside the code.

### 3. Commit the changeset

```sh
git add .changeset/
git commit -m "chore: add changeset for package release"
git push
```

Commit messages must follow Conventional Commit style. Do not include any author/agent identity in the commit message.

### 4. Prepare a release branch

Changesets accumulate on `main` without opening a version PR or publishing. Create `release/<cycle>` from the chosen main commit. Pushes to that branch maintain `ci: release packages`, targeting the same release branch, with head `changeset-release/release/<cycle>`.

The Release workflow also accepts `operation=prepare` on the selected release branch. Use this explicitly when automation creates the branch with `GITHUB_TOKEN`, because token-authored pushes do not trigger other workflows. Dispatch `ci.yml` explicitly in that case too. Generated version PRs receive an explicit CI dispatch because their token-authored PR events do not start ordinary PR checks.

Keep the version PR open while testing and fixing the candidate. Fixes carry changesets. Remove or disable deferred code on release as well as excluding its changeset; deleting a changeset alone does not remove shipped code. Keep the deferred changeset on main when main retains that feature. Do not merge unrelated new main commits into the release branch.

### 5. Review and merge the version PR

The version command runs `changeset version` and records `.changeset/release-plan.json`: the release branch, consumed changeset filenames, and changed package versions. The file is generated by `scripts/version-release.mjs`; do not edit it manually. The PR updates versions, dependency ranges, lockfile and changelogs and deletes consumed changesets. Review and merge it only when content is ready. Merging does not publish.

Wait for CI on the resulting release commit. Version-PR checks or earlier preview builds do not replace these checks. If fixes arrive after the version PR was merged, add changesets and review another version PR; the plan retains the packages already selected for this cycle. Retest the new commit. Prepare only one formal release cycle at a time.

### 6. Publish the tested commit

In Actions, select Release and the release branch, choose `operation=publish`, and enter the full 40-character tested commit as `expected_sha`. Publication rejects main, mismatched SHA, pending changesets, a plan from another branch, changed package versions, or a latest CI run that has not succeeded on that commit.

The workflow keeps npm Trusted Publishing in `release.yml`, builds packages and publishes through Changesets. It first binds package tags to the selected commit and creates draft GitHub Releases. Native artifacts are built when the plan includes the CLI, even if npm publication succeeded on an earlier attempt. After uploads succeed, the drafts become public. An existing tag at a different commit fails. Retry the same commit to complete interrupted publication; published releases are not overwritten. Source changes require a new version rather than moving an existing tag.

VS Code publishing is separate: select the release branch in `vscode-publish.yml`, supply the same `expected_sha`, and require the extension to be included in the release plan. Existing per-platform marketplace checks still allow retries to fill missing platforms. Main version updates never publish the extension.

### 7. Sync back after publication

Keep CDN distribution, release notes and announcements as explicit follow-up operations. Open a separate PR to sync the version changes, lockfile, changelogs, release plan and consumed changeset deletions back to main, along with any general fixes still missing there. Preserve main's new and deferred changesets. Do not blindly merge release-only feature reversions back into main.

Docs continue to deploy from main. Merging docs updates triggers `docs-deploy.yml`; publication on a release branch no longer invokes the main-only deployment. Sync release metadata before preparing the docs changelog PR.

Record the app commit, core commit, Desktop submodule revision and web dist source for a paired release. Matching branch names alone do not establish compatibility.

### Initial migration

Merge the workflow changes first. Maintainers then close the old main version PR without deleting main's pending changesets, create the release branch, and prepare its version PR. These are separate operations; merging this workflow change does not perform them.

## Notes

- Every PR that affects publishable-package behavior or public API should include a corresponding changeset.
- Changes under `plugins/` (the bundled official plugins such as `kimi-datasource`) do **not** need a changeset: each plugin carries its own version in `kimi.plugin.json` and `plugins/marketplace.json` and is distributed via the marketplace CDN, separately from the `@moonshot-ai/kimi-code` npm package.
- Changeset files must be committed to the repository — release PRs are only triggered after they're merged.
- Release PRs require human review and merge; they will not publish automatically.
- Do not add release changesets for private internal packages; only select `@moonshot-ai/kimi-code` and `@moonshot-ai/kimi-code-sdk`.
- If a change in an underlying internal package alters user-visible behavior or public API of a publishable package, add a changeset to the affected publishable package. For example, when a bug fixed in `@moonshot-ai/kosong` resolves an issue CLI users encounter, add a changeset to `@moonshot-ai/kimi-code` describing the user-visible fix.
- `@moonshot-ai/kimi-code` is the official CLI package name; after a global install it provides the `kimi` command.
- Make sure each publishable package on npm has a Trusted Publisher configured.

## References

- [Changesets documentation](https://github.com/changesets/changesets)
- [Changesets GitHub Action](https://github.com/changesets/action)
- [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers)
