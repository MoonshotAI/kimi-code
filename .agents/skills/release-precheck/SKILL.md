---
name: release-precheck
description: Use before merging a kimi-code release PR to audit the changesets it will publish — flag merged PRs that forgot a changeset or picked an inappropriate bump level (minor / major / patch), wrong package, or non-compliant wording. Outputs the release PR link plus a suggestion table.
---

# Release Precheck

`kimi-code` uses changesets. On every push to `main`, the `Release` workflow opens/updates a release PR titled **`ci: release packages`** (branch `changeset-release/main`); merging it consumes `.changeset/*.md`, bumps versions, and publishes. This skill audits that PR **before** merge and reports the **release PR link** plus a **suggestion table**.

For authoring a changeset, use `gen-changesets`. For its bump-level / package / wording rules, skim `gen-changesets` first — this skill only adds the audit workflow and missing-changeset detection. All `gh` commands target `MoonshotAI/kimi-code` (the `origin` of this checkout).

## Key Facts

Read `.changeset/config.json` for the current ignore list. In short:

- Released packages: `@moonshot-ai/kimi-code` (CLI — list it for almost everything) and `@moonshot-ai/kimi-code-sdk` (only when `packages/node-sdk` src changes).
- Ignored packages must **never** appear in frontmatter: `agent-core`, `kaos`, `kosong`, `protocol`, `server`, `server-e2e`, `migration-legacy`, `kimi-code-oauth`, `kimi-telemetry`, `acp-adapter`, `kimi-web`, `vis`, `vis-server`, `vis-web`, `kimi-migration-legacy`.
- Ignored packages (including `kimi-web`) are bundled into the CLI: a change that reaches the CLI lists `@moonshot-ai/kimi-code` instead and describes the user-visible effect.

## Workflow

### 1. Locate the release PR

```bash
gh pr list --state open --search "ci: release packages in:title" \
  --json number,title,url,headRefName,baseRefName,createdAt,updatedAt
```

Pick the one with `headRefName: changeset-release/main`.

- **One open** → record `number`, `url`, `baseRefName` as `<RELEASE>`. Continue.
- **None open** → nothing to release. Report it and stop. Offer to audit the latest merged release (see "Inspecting an already-merged release") only if the user asks:

  ```bash
  gh pr list --state merged --search "ci: release packages in:title" --json number,url,mergedAt --limit 1
  ```

### 2. Collect the changesets

```bash
gh pr view <RELEASE> --json files --jq '.files[].path' \
  | grep '^\.changeset/.*\.md$' | grep -vE '(^|/)(README|config)\.md$'
```

Read each from the PR's **base** ref (the release PR deletes them, so while open they still live on `main`):

```bash
gh api "repos/MoonshotAI/kimi-code/contents/<changeset-path>?ref=<baseRefName>" --jq .content | base64 -d
```

Parse frontmatter (package → bump level) + body. Format:

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add an environment variable to cap AgentSwarm concurrency during the initial ramp, so large swarms do not trip provider rate limits as easily.
```

### 3. Map each changeset to its source PR

The release PR's CHANGELOG patch links every entry to the PR that added the changeset (`gh pr diff <PR> -- <path>` is **not** supported by `gh`, so use the API):

```bash
gh api repos/MoonshotAI/kimi-code/pulls/<RELEASE>/files \
  --jq '.[] | select(.filename=="apps/kimi-code/CHANGELOG.md") | .patch'
```

Lines start with `+-` (diff `+` + markdown `-`). Match each changeset **body** to the text after the PR/hash decoration; the `[#NNN]` is the source PR.

Fallback (when body text does not match):

```bash
gh api "repos/MoonshotAI/kimi-code/commits?path=<changeset-path>&sha=<baseRefName>&per_page=5" --jq '.[].sha' \
  | xargs -I{} gh api "repos/MoonshotAI/kimi-code/commits/{}/pulls" --jq '.[].number'
```

### 4. Find merged PRs in this release window

Window start = previous release PR's merge time (while the current release is open, the latest merged release is the previous one):

```bash
gh pr list --state merged --search "ci: release packages in:title" --json number,mergedAt --limit 1 --jq '.[0].mergedAt'
```

Candidate PRs merged into `main` after that moment (drop the release PRs themselves):

```bash
gh pr list --state merged --base <baseRefName> \
  --search "merged:<PREV_RELEASE_MERGED_AT>..$(date -u +%Y-%m-%dT%H:%M)" \
  --json number,title,url,mergedAt,labels --limit 100
```

`gh` caps `--limit` at 100; narrow the date range to page.

### 5. Classify each candidate PR

For each candidate, `gh pr view <PR> --json files --jq '.files[].path'`, then decide:

**(a) Did it add a changeset?** Yes if its file list has a new `.changeset/<name>.md` (not `README.md` / `config.json`).

**(b) Should it have had one?** From the file list (+ title/diff when unclear):

| Files touched | Changeset? |
|---|---|
| Only `docs/**`, `**.md`, `**.mdx`, `LICENSE`, `SECURITY.md` | No |
| Only `*.test.ts`, `*.spec.ts`, `**/test/**`, `__tests__`, snapshots | No |
| Only `.github/**`, `scripts/**`, `build/**`, `flake.nix`, `pnpm-lock.yaml`, repo `package.json` | Usually No — unless it changes a shipped build artifact |
| `apps/kimi-code/src/**` | Yes → `@moonshot-ai/kimi-code` |
| `apps/kimi-web/**` | Yes → `@moonshot-ai/kimi-code` |
| `packages/node-sdk/src/**` | Yes → `@moonshot-ai/kimi-code-sdk` |
| `packages/agent-core/**`, `packages/kosong/**`, `packages/kaos/**`, `packages/protocol/**`, `packages/server/**`, `packages/oauth/**`, `packages/telemetry/**`, `packages/acp-adapter/**`, `packages/migration-legacy/**` | Yes **if** it reaches the CLI/SDK artifact → list the released package, not the internal one. No if purely internal |
| `apps/vis/**`, `server-e2e/**`, other non-shipping ignored apps | No |

A PR that needs a changeset but has none → **Missing changeset**.

### 6. Evaluate each changeset

For every changeset from step 2 (paired with its source PR), check:

1. **Bump level vs. change.** PR titles are Conventional Commits: `feat` → `minor`; `fix`/`perf`/`refactor`/`chore`/`build`/`style`/`test`/`docs` → `patch` (or none if out-of-bundle); `!` or `BREAKING CHANGE` → `major`. Watch for titles that under-sell the diff (a `fix` adding a capability = `minor`; a `feat` that only tweaks internals = `patch`).
2. **Package.** No ignored package in frontmatter (changesets rejects it); CLI listed for bundled `kimi-web` / internal changes; SDK listed iff `packages/node-sdk` src changed (a PR touching both CLI and `node-sdk` may need both packages); no mixed ignored + non-ignored in one frontmatter.
3. **Wording.** English; one short honest sentence; no file/class/function names, PR numbers, or hashes; no real internal endpoints/key/account/service names (use `example.com`, `example.test`, `YOUR_API_KEY`); no vague `refactor`/`improve`/`optimize` unless the actual change is named.
4. **`major`.** Stop and surface to the user — never decide or downgrade it yourself.

### 7. Output

Be concise: give links directly, write `无` for empty sections, skip prose. Format:

```
发版 PR: <url or 无>

| Source PR | Change | Package | Declared | Suggested | Status | Note |
|---|---|---|---|---|---|---|
| #888 | cap AgentSwarm concurrency | @moonshot-ai/kimi-code | minor | minor | OK | — |
| #839 | guided goal authoring | — | — | minor | Missing changeset | feat touching CLI + agent-core |

漏写 changeset: #839, #885     (无 if none)
阻塞问题: 无
结论: safe to merge              (safe to merge / merge after fixes / hold for confirmation)
```

- One table covers every changeset **and** every missing-changeset PR; `Status` distinguishes them.
- `Status` ∈ `OK`, `Missing changeset`, `Wrong level`, `Wrong package`, `Wording`, `Major needs confirmation`, `Out of bundle`. Combine with `+` when needed.
- `漏写 changeset` lists only PRs that should have had one (exclude `Out of bundle`). If still fixable before merge, note it and point to `gen-changesets`.
- `阻塞问题`: invalid frontmatter (ignored/mixed package), unconfirmed `major`, leaked internal identifier; otherwise `无`.

## Inspecting an already-merged release

Same workflow, two adjustments:

- Changesets are gone from `main`; read them from the merge commit's parent:

  ```bash
  PARENT=$(gh api repos/MoonshotAI/kimi-code/commits/<MERGE_COMMIT_SHA> --jq '.parents[0].sha')
  gh api "repos/MoonshotAI/kimi-code/contents/<changeset-path>?ref=$PARENT" --jq .content | base64 -d
  ```

  Get `<MERGE_COMMIT_SHA>` from `gh pr view <RELEASE> --json mergeCommit --jq .mergeCommit.oid`.
- Window end = the release PR's `mergedAt` (not "now"); window start = the previous release PR's `mergedAt` (`--limit 2` on the merged list, take the older one).
- A missing changeset cannot be fixed for that version — frame it as a follow-up (add a changeset next release).

## Notes

- Read-only. Never edit a changeset/changelog here; fixes go through a follow-up PR via `gen-changesets`.
- Not every in-window PR without a changeset is a bug — docs/test/CI/internal-only changes legitimately have none. Classify first.
- Stop and ask the user on any `major` declaration; on invalid frontmatter (ignored/mixed package) or leaked internal identifier, flag as blocking.
- If the source PR of a changeset cannot be determined after both methods in step 3, mark it `Unknown source PR`; do not guess.
