---
name: pre-changelog
description: Use before merging a kimi-code release PR to preview the user-facing changelogs in Chinese — the CLI changelog (docs site) and the desktop changelog (update-dialog source). Reads the changelog blocks changesets pre-generated in the release PR, reusing sync-changelog's Flow A / Flow B logic. Writes no files.
---

# Pre-Changelog

Preview the user-facing **Chinese** changelogs of an open release PR **before** it is merged. Read-only: this skill writes no files and commits nothing.

A release PR (created by `scripts/version-release.mjs` on a `release/*` branch) can bump several products at once — the CLI, desktop, and the VS Code extension — and pre-generates each bumped product's `CHANGELOG.md`. This skill renders Chinese previews for the two Chinese surfaces:

- **CLI** (`apps/kimi-code/CHANGELOG.md`) → the docs-site changelog, per `sync-changelog` **Flow A**.
- **Desktop** (`apps/desktop/CHANGELOG.md`) → the update-dialog notes, per `sync-changelog` **Flow B**.

The VS Code extension changelog is English-only (marketplace surface); when present in the diff, mention it but do not render a preview.

Read `sync-changelog` first; only the data source (release PR diff instead of a published `CHANGELOG.md`) and the output (preview instead of files) differ.

## Workflow

### 1. Locate the release PR

Select the open version PR for the intended `release/*` branch:

```bash
gh pr list --state open --search "ci: release packages in:title" \
  --json number,title,url,headRefName,baseRefName
```

Pick the one whose `baseRefName` is the intended `release/*` branch (its `headRefName` is `changeset-release/<that branch>`); record `number`, `url` as `<RELEASE>`. If none is open, nothing to preview — stop. Report the PR's latest head CI link and result alongside the preview.

### 2. Read the pre-generated changelog blocks

changesets already pre-generates each bumped product's `CHANGELOG.md` inside the release PR. Extract the new version block from each product's diff:

```bash
gh api repos/MoonshotAI/kimi-code/pulls/<RELEASE>/files \
  --jq '.[] | select(.filename | endswith("CHANGELOG.md")) | {filename, patch}'
```

For `apps/kimi-code/CHANGELOG.md` and `apps/desktop/CHANGELOG.md`, take the added lines (`+`) from the top `## <version>` down to (but not including) the next `## `. That is the version block to preview for that product.

If neither product changelog is in the diff (for example a library-only release), stop and tell the user — there is no user-facing changelog to preview. If only one is present, preview that one.

### 3. Render the Chinese previews (reuse `sync-changelog`)

**CLI block — Flow A rules.** Process the version block exactly as `sync-changelog` Flow A does for the docs site, in memory only:

- **Strip** (Flow A step 3): drop the H1, the `### Patch Changes` / `### Minor Changes` / `### Major Changes` subheadings, PR links, and commit-hash links; keep only each entry's body text. The `Thanks [@user](...)!` credit (including the multi-author form) must be removed every time. Within each entry, drop SDK-only and provider-internal sentences (SDK capability mapping / API exposure, provider wire-format mechanics, internal XML markers, hook/event payload mechanics) and keep only the user-facing effect and required constraints.
- **Merge and deduplicate** (Flow A step 4): merge micro-tweaks to the same surface into one higher-level entry; when three or more fixes target the same UI area or the same class of problem, merge them into one higher-level fix entry (do not merge broad or genuinely distinct fixes); and drop a server/API entry that only backs a web feature already listed.
- **Collapse low-signal entries** (Flow A step 4): keep standalone only entries that pass both gates — the reader-action test and the channel test. Polish keeps only must-react items; fixes keep only behavior-change entries. Section sizes follow the density defaults (about 2 Polish, 3 Bug Fixes) that yield to genuinely qualifying entries — flag the overflow for the reviewer. Fold everything else into one catch-all line placed last under 修复 — `修复了一些已知问题。` (or `修复了一些已知问题，并做了若干细节优化。` when non-fix entries were also collapsed; when nothing folded is a fix, place it under 优化 instead as `做了若干细节优化和内部改进。`), followed by the pointer sentence `更详细的变更记录见 [GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md)。` (file link, no version anchor; before the release PR merges, the target does not yet contain this version's block — expected for a preview).
- **Classify** (Flow A step 4): bucket into Features / Bug Fixes / Polish / Refactors / Other; order within each section by reader value.
- **Translate** (Flow A step 6): translate entry bodies to Chinese; keep one sentence per entry with a parallel rhythm within a section; section headings become 新功能 / 优化 / 修复 / 重构 / 其他.

**Desktop block — Flow B rules.** Process the desktop version block exactly as `sync-changelog` Flow B does for the update-dialog notes, in memory only:

- **Strip** and **merge** as above (Flow B steps 2–3).
- **Classify** into 新功能 / 优化 / 修复 / 其他 (no 重构 section) and order by reader value.
- **Apply the length limits**: 中文 ≤ 40 字、一条一效果、≤ 10 条。Flag entries that exceed the limits in the preview instead of silently compressing — the release owner curates Flow B for real at publish time, and the preview exists to surface these violations early.

If an upstream entry is not in English, flag it and stop (changeset entries must be English).

### 4. Output

Print the previews directly, one per product, using `<product> <version>（预览）` as the heading because the version is not released yet. Write `无` for empty sections. Do not write any file.

For the CLI preview, rewrite every docs link to its absolute published URL: map `../<path>.md[#anchor]` to `https://moonshotai.github.io/kimi-code/zh/<path>.html[#anchor]` — for example `../configuration/config-files.md#loop-control` → `https://moonshotai.github.io/kimi-code/zh/configuration/config-files.html#loop-control`. Never emit raw relative paths, and never wrap a link in backticks; code-style the link text inside the brackets instead ([`loop_control`](...)).

After the previews, append a reviewer-only section titled `### 审稿参考（不进入文档）`: list every entry folded into the catch-all (short English title, one line each), note any section that exceeds the density defaults, flag borderline calls, and list any desktop entries that violate the Flow B length limits. This breakdown is how reviewers see what was folded and what needs curation — before merge, the catch-all pointer's target does not yet contain the version's block. Never write this section into the docs pages or the release-notes files.

```
发版 PR: <url>

## kimi-code <version>（预览）

### 新功能
- ...

### 修复
- ...

## kimi-code-desktop <version>（预览）

### 新功能
- ...

### 修复
- ...
```

## Rules

- Read-only. Never write `CHANGELOG.md`, docs files, release-notes files, or commit anything.
- Classification, ordering, length limits, and translation follow `sync-changelog` Flow A / Flow B exactly — do not reword or reclassify beyond what they specify.
- If the release PR has no CLI or desktop changelog diff, report it and stop.
