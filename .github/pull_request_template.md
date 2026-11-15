<!--
Thank you for your contribution to Kimi Code!
External PRs are accepted for approved bug fixes only: link an issue that a maintainer has approved (an `/approve` comment). External feature PRs are not accepted.
外部 PR 仅接受获批准的 bug 修复：请链接维护者已批准（`/approve` 评论）的 issue；不接受外部 feature PR。

See https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md for more.
-->

## Requirement or Bug

<!-- If there's an issue, write Resolve #(issue_number) and add one sentence of context.
     Otherwise, in 2–3 plain sentences: who hits what problem, and what this PR makes possible. -->

## Bug Reproduction Steps

<!-- Required for bug PRs only; write N/A for feature PRs.
     Prefer writing in the issue and linking here; if no issue exists, write directly. -->

## Root Cause

<!-- Required for bug PRs only. Explain the root cause.
     State whether this is a fundamental fix or a workaround. -->

## Code Changes

<!-- Help the reviewer understand the change without reading the diff.
     For changes that span modules, introduce new concepts, or replace an old path, start with the
     core idea and a diagram of the resulting structure, then the key decisions and where to start reading.
     Pair diagrams and tables with sentences that explain why.
     If the UI changes, add a "Screenshots / Recordings" section with before/after images. -->

## Behavior Changes and Affected Users

<!-- List every observable behavior this PR changes, one row each, including behavior you
     consider "unchanged" whose branch conditions moved, and prompt-text edits sentence by sentence.
     | Behavior | Before | After | Who relies on the old behavior | Escape hatch |
     Name affected users concretely (client, provider dialect, platform, config state, data written
     by older versions, external scripts); see .agents/skills/review-pr/surfaces.md.
     Write "None" with evidence if nothing observable changes.
     Then list affected modules and the test coverage for each row. -->

## Checklist

- [ ] I have read the [CONTRIBUTING](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md) document.
- [ ] I have linked a related issue (external PRs: issue must have a maintainer's `/approve`).
- [ ] I have added tests that prove my feature works.
- [ ] The behavior-change table above is complete, and every removed behavior or flipped default is named in the changeset and either has an escape hatch or was explicitly approved by a maintainer in this PR.
- [ ] Ran `gen-changesets` skill, or this PR needs no changeset.
- [ ] Ran `gen-docs` skill, or this PR needs no doc update.
