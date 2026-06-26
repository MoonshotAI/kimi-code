---
name: pre-changelog
description: Use before merging a kimi-code release PR to preview the user-facing CLI changelog in Chinese. Reads the changelog that changesets pre-generated in the release PR, then reuses sync-changelog's strip / classify / translate logic to render a Chinese preview. Writes no files.
---

# Pre-Changelog

Preview the user-facing **Chinese** changelog of an open `kimi-code` release PR **before** it is merged. Read-only: this skill writes no files and commits nothing.

This skill reuses `sync-changelog`'s strip / classify / translate rules. Read `sync-changelog` first; only the data source (release PR diff instead of a published `CHANGELOG.md`) and the output (preview instead of docs files) differ.

## Workflow

### 1. Locate the release PR

```bash
gh pr list --state open --search "ci: release packages in:title" \
  --json number,title,url,headRefName,baseRefName
```

Pick the one with `headRefName: changeset-release/main`; record `number`, `url` as `<RELEASE>`. If none is open, nothing to preview — stop.

### 2. Read the pre-generated CLI changelog block

changesets already pre-generates `apps/kimi-code/CHANGELOG.md` inside the release PR. Extract the new version block from the diff:

```bash
gh api repos/MoonshotAI/kimi-code/pulls/<RELEASE>/files \
  --jq '.[] | select(.filename=="apps/kimi-code/CHANGELOG.md") | .patch'
```

Take the added lines (`+`) from the top `## <version>` down to (but not including) the next `## `. That is the version block to preview.

If the CLI changelog is not in the diff (for example an SDK-only release), stop and tell the user — there is no user-facing CLI changelog to preview.

### 3. Render the Chinese preview (reuse `sync-changelog`)

Process the version block exactly as `sync-changelog` does for the docs site, but only in memory:

- **Strip** (`sync-changelog` step 3): drop the H1, the `### Patch Changes` / `### Minor Changes` / `### Major Changes` subheadings, PR links, and commit-hash links; keep only each entry's body text.
- **Classify** (`sync-changelog` step 4): bucket into Features / Bug Fixes / Polish / Refactors / Other; order within each section by reader value.
- **Translate** (`sync-changelog` step 6): translate entry bodies to Chinese; section headings become 新功能 / 修复 / 优化 / 重构 / 其他.

If an upstream entry is not in English, flag it and stop (changeset entries must be English).

### 4. Output

Print the preview directly. Use `<version>（预览）` as the heading because the version is not released yet. Write `无` for empty sections. Do not write any file.

```
发版 PR: <url>

## <version>（预览）

### 新功能
- ...

### 修复
- ...
```

## Rules

- Read-only. Never write `CHANGELOG.md`, docs files, or commit anything.
- Classification, ordering, and translation follow `sync-changelog` exactly — do not reword or reclassify beyond what it specifies.
- If the release PR has no CLI changelog diff, report it and stop.
