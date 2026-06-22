---
name: release-precheck
description: Use before merging a kimi-code release PR to audit the changesets it will publish — flag merged PRs that forgot a changeset or picked an inappropriate bump level (minor / major / patch), wrong package, or non-compliant wording. Outputs the release PR link plus a suggestion table.
---

# Release Precheck

`kimi-code` uses changesets. On every push to `main`, the `Release` workflow opens/updates a release PR titled **`ci: release packages`** (branch `changeset-release/main`); merging it consumes `.changeset/*.md`, bumps versions, and publishes. This skill audits that PR **before** merge and reports the **release PR link** plus a **suggestion table**.

For authoring a changeset and the bump-level / package / wording rules, skim `gen-changesets` first — this skill adds the audit workflow and missing-changeset detection. All `gh` commands target `MoonshotAI/kimi-code` (the `origin` of this checkout).

## Key Facts

- Released packages: `@moonshot-ai/kimi-code` (CLI — almost everything) and `@moonshot-ai/kimi-code-sdk` (only when `packages/node-sdk/src` changes).
- Ignored packages must **never** appear in frontmatter — see `.changeset/config.json` for the full list. They are bundled into the CLI, so a user-visible change in any of them lists `@moonshot-ai/kimi-code` instead and describes the user-visible effect.

## Workflow

### 1. Locate the release PR

```bash
gh pr list --state open --search "ci: release packages in:title" \
  --json number,title,url,headRefName,baseRefName
```

Pick the one with `headRefName: changeset-release/main`; record `number`, `url`, `baseRefName` as `<RELEASE>`. If none is open, nothing to release — stop (or, only if asked, audit the latest merged release instead; see below).

### 2. Collect the changesets and their source PRs

List the changeset files added by the release PR:

```bash
gh pr view <RELEASE> --json files --jq '.files[].path' \
  | grep '^\.changeset/.*\.md$' | grep -vE '(^|/)(README|config)\.md$'
```

Read each from the PR's **base** ref (the release PR deletes them, so while open they still live on `main`) and parse its frontmatter (package → bump) + body:

```bash
gh api "repos/MoonshotAI/kimi-code/contents/<changeset-path>?ref=<baseRefName>" --jq .content | base64 -d
```

Find the source PR (the PR that introduced the changeset) via the file's commit history — this works for both CLI and SDK changesets:

```bash
gh api "repos/MoonshotAI/kimi-code/commits?path=<changeset-path>&sha=<baseRefName>&per_page=5" --jq '.[].sha' \
  | xargs -I{} gh api "repos/MoonshotAI/kimi-code/commits/{}/pulls" --jq '.[].number'
```

If that yields nothing, fall back to the release PR's changelog diff, which links each entry to its source PR — read **both** `apps/kimi-code/CHANGELOG.md` and `packages/node-sdk/CHANGELOG.md`.

### 3. Find merged PRs in this release window

Window start = the previous release PR's merge time (the latest merged release, while the current one is open):

```bash
gh pr list --state merged --base <baseRefName> --search "ci: release packages in:title" \
  --json number,mergedAt --limit 1 --jq '.[0].mergedAt'
```

List candidate PRs merged into `<baseRefName>` and drop anything merged at or before that moment, plus the release PRs themselves:

```bash
gh pr list --state merged --base <baseRefName> --json number,title,url,mergedAt --limit 100
```

`gh` caps `--limit` at 100; narrow with `--search "merged:>=<ISO8601>"` if needed.

### 4. Classify each candidate PR

For each candidate, `gh pr view <PR> --json files --jq '.files[].path'`, then decide:

**(a) Did it add a changeset?** Yes if its file list has a new `.changeset/<name>.md` (not `README.md` / `config.json`).

**(b) Should it have had one?** Ask one question: **can an end user notice this change?**

- **Yes → needs a changeset.**
  - Touches `packages/node-sdk/src` → `@moonshot-ai/kimi-code-sdk`.
  - Anything else user-visible (CLI behavior/output, bundled web/internal, `apps/vis/web` + `apps/vis/server`) → `@moonshot-ai/kimi-code`.
- **No → no changeset:** docs-only, tests, CI/build, repo meta (`flake.nix`, `pnpm-lock.yaml`, root `package.json`), or purely internal changes with no user-visible effect (e.g. `apps/vis/scripts/**`, `packages/server-e2e/**`).
- **Unsure** → open the diff and judge by user-visible effect; ask the user if still ambiguous.

A PR that needs a changeset but has none → **Missing changeset**.

### 5. Evaluate each changeset

For every changeset from step 2 (paired with its source PR), check:

1. **Bump level vs. change.** `feat` → `minor`; `fix`/`perf`/`refactor`/`chore`/`build`/`style`/`test`/`docs` → `patch` (or none if out-of-bundle); `!` or `BREAKING CHANGE` → `major`. Watch for titles that under-sell the diff (a `fix` adding a capability = `minor`; a `feat` that only tweaks internals = `patch`).
2. **Package.** No ignored package in frontmatter; CLI listed for bundled/internal changes; SDK listed iff `packages/node-sdk/src` changed; no mixed ignored + non-ignored in one frontmatter.
3. **Wording.** English; one short honest sentence; no file/class/function names, PR numbers, or hashes; no real internal endpoints/keys/account/service names (use `example.com`, `example.test`, `YOUR_API_KEY`); no vague `refactor`/`improve`/`optimize` unless the actual change is named.
4. **`major`.** Stop and surface to the user — never decide or downgrade it yourself.

### 6. Output

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

Same workflow, three adjustments:

- Changesets are gone from `main`; read them from the merge commit's parent:

  ```bash
  PARENT=$(gh api repos/MoonshotAI/kimi-code/commits/<MERGE_COMMIT_SHA> --jq '.parents[0].sha')
  gh api "repos/MoonshotAI/kimi-code/contents/<changeset-path>?ref=$PARENT" --jq .content | base64 -d
  ```

  Get `<MERGE_COMMIT_SHA>` from `gh pr view <RELEASE> --json mergeCommit --jq .mergeCommit.oid`.
- Window end = the release PR's `mergedAt`; window start = the previous release PR's `mergedAt` (`--limit 2` on the merged list, take the older one).
- A missing changeset cannot be fixed for that version — frame it as a follow-up.

## Notes

- Read-only. Never edit a changeset/changelog here; fixes go through a follow-up PR via `gen-changesets`.
- Not every in-window PR without a changeset is a bug — classify first.
- Stop and ask the user on any `major` declaration; flag invalid frontmatter or leaked internal identifier as blocking.
- If a changeset's source PR cannot be determined, mark it `Unknown source PR`; do not guess.
