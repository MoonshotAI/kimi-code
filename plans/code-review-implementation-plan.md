# Code Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a built-in `/review` command with Standard, Thorough, and Deep review intensities, read-only reviewer workers, audited coverage, and provenance-preserving reconciliation.

**Architecture:** The TUI owns interaction and display, the SDK exposes typed review APIs, and `packages/agent-core` owns review state, git target resolution, review tools, reviewer orchestration, coverage auditing, and reconciliation. Start behind an experimental flag and ship the feature in slices: Standard first, then Thorough, then Deep.

**Tech Stack:** TypeScript, Vitest, existing RPC layer, existing subagent host, existing profile system, existing permission policy system, existing TUI `ChoicePickerComponent`.

---

## Lifecycle Map

The review lifecycle crosses these project areas:

- `apps/kimi-code/src/tui/commands`: add `/review`, parse optional focus text, and launch the selector flow.
- `apps/kimi-code/src/tui/components/dialogs`: reuse `ChoicePickerComponent` for scope, base/commit selection, intensity, perspective confirmation, and stop-review confirmation.
- `apps/kimi-code/src/tui/controllers`: route review progress events and cancellation into the live UI.
- `packages/node-sdk/src`: expose typed review methods so the app never imports `@moonshot-ai/agent-core` directly.
- `packages/agent-core/src/rpc`: add review RPC payloads and methods.
- `packages/agent-core/src/review`: new review domain runtime: targets, assignments, comments, coverage, progress, orchestration, reconciliation.
- `packages/agent-core/src/tools/builtin/review`: new review-safe tools: `GetAssignment`, `GetChangedFiles`, `ReadPatch`, `ReadFileVersion`, `UpdateProgress`, `AddComment`, `GetComments`, `GetCommentEvidence`, `MergeComments`, `DismissComment`.
- `packages/agent-core/src/profile/default`: add `reviewer` and `reconciliator` profiles, then register them as subagent profiles for the main agent.
- `packages/agent-core/src/agent/permission/policies`: add a review-mode guard that blocks mutation and orchestration tools for review workers.
- `packages/agent-core/src/agent/injection`: inject review background and assignment context at reviewer turn start and after compaction.

## Phase 0: Feature Flag and Shared Types

Purpose: create the compile-time and runtime surface without changing user behavior.

**Files:**

- Modify: `packages/agent-core/src/flags/registry.ts`
- Create: `packages/agent-core/src/review/types.ts`
- Create: `packages/agent-core/src/review/index.ts`
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/node-sdk/src/types.ts`

**Tasks:**

- [x] Add experimental flag `code_review` in `packages/agent-core/src/flags/registry.ts` with env `KIMI_CODE_EXPERIMENTAL_CODE_REVIEW`, default `false`, surface `both`.
- [x] Define review enums and data types in `packages/agent-core/src/review/types.ts`:
  - `ReviewScopeKind = 'working_tree' | 'current_branch' | 'single_commit'`
  - `ReviewIntensity = 'standard' | 'thorough' | 'deep'`
  - `ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'`
  - `ReviewProgressStatus = 'active' | 'complete' | 'blocked'`
  - `ReviewCommentSeverity = 'critical' | 'important' | 'minor'`
  - `ReviewTarget`, `ReviewFileChange`, `ReviewDiffStats`, `ReviewAssignment`, `ReviewComment`, `ReviewMergedComment`, `ReviewProgress`
- [x] Export review types from `packages/agent-core/src/review/index.ts` and `packages/agent-core/src/index.ts`.
- [x] Re-export public SDK-facing review types from `packages/node-sdk/src/types.ts`.
- [x] Add unit tests for type-facing validators when they are backed by Zod schemas. Prefer `packages/agent-core/test/review/types.test.ts` if no nearby review test exists yet. No validator tests were needed in Phase 0 because the slice adds type-only aliases and interfaces.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core run typecheck`.
- [x] Run `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`.

## Phase 1: Git Target Resolver and Diff Preview

Purpose: support scope selection and diff-stat preview before any model work starts.

**Files:**

- Create: `packages/agent-core/src/review/git-target.ts`
- Create: `packages/agent-core/src/review/git-target.test-support.ts`
- Create: `packages/agent-core/test/review/git-target.test.ts`
- Modify: `packages/agent-core/src/review/index.ts`

**Tasks:**

- [x] Implement `resolveReviewTarget(kaos, input)` for:
  - working tree changes
  - current `HEAD` against a selected branch, commit, or tag
  - one selected commit
- [x] Implement `listReviewBaseRefs(kaos)` returning local branches, tags, and recent commits for the TUI selector.
- [x] Implement `listReviewCommits(kaos)` for the single-commit selector.
- [x] Implement `previewReviewTarget(kaos, target)` returning:
  - file count
  - added lines
  - deleted lines
  - changed file manifest
- [x] Make untracked files part of working-tree review. For untracked text files, treat the whole file as an added patch.
- [x] Keep this layer model-free and side-effect-free. It may run read-only git commands through Kaos, but must not write to the repository.
- [x] Test renamed, deleted, untracked, and single-commit cases.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/git-target.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/review/git-target.test.ts` because Vitest runs from the package directory.

## Phase 2: Review Runtime Store, Coverage, and Comments

Purpose: create central session-owned review state that workers and reconciliators can update through tools.

**Files:**

- Create: `packages/agent-core/src/review/runtime.ts`
- Create: `packages/agent-core/src/review/coverage.ts`
- Create: `packages/agent-core/src/review/comments.ts`
- Create: `packages/agent-core/test/review/runtime.test.ts`
- Modify: `packages/agent-core/src/session/index.ts`
- Modify: `packages/agent-core/src/agent/index.ts`

**Tasks:**

- [x] Add a `SessionReviewRuntime` that stores active review runs, assignments, progress, comments, merged comments, dismissed comments, and coverage.
- [x] Add a per-agent review facade, passed from `Session.instantiateAgent`, so an agent can call review tools without storing a session or agent id directly on `Agent`.
- [x] Preserve the existing rule that `Agent` remains usable standalone. If no review facade is supplied, review tools should not be active and review injections should no-op.
- [x] Implement coverage tracking for:
  - patch hunks read through `ReadPatch`
  - file line ranges read through `ReadFileVersion`
  - full-file coverage completion for multi-call large file reads
- [x] Implement comment state:
  - `AddComment` creates candidate comments and returns a comment id
  - `MergeComments` creates merged comments and stores source comment ids
  - `DismissComment` stores dismissal reason and optional merged comment id
- [x] Enforce invariants in runtime methods:
  - `AddComment` requires the cited path and line to be covered
  - `MergeComments` requires at least one source comment
  - `MergeComments` requires cited path and line support from source coverage
  - `UpdateProgress({ status: 'complete' })` fails while required coverage is missing
- [x] Add unit tests for coverage and comment invariants.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/runtime.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/review/runtime.test.ts` because Vitest runs from the package directory.

## Phase 3: Review Tools

Purpose: expose model-facing tools with small, clear schemas.

**Files:**

- Create: `packages/agent-core/src/tools/builtin/review/get-assignment.ts`
- Create: `packages/agent-core/src/tools/builtin/review/get-changed-files.ts`
- Create: `packages/agent-core/src/tools/builtin/review/read-patch.ts`
- Create: `packages/agent-core/src/tools/builtin/review/read-file-version.ts`
- Create: `packages/agent-core/src/tools/builtin/review/update-progress.ts`
- Create: `packages/agent-core/src/tools/builtin/review/add-comment.ts`
- Create: `packages/agent-core/src/tools/builtin/review/get-comments.ts`
- Create: `packages/agent-core/src/tools/builtin/review/get-comment-evidence.ts`
- Create: `packages/agent-core/src/tools/builtin/review/merge-comments.ts`
- Create: `packages/agent-core/src/tools/builtin/review/dismiss-comment.ts`
- Create: `packages/agent-core/src/tools/builtin/review/*.md` descriptions for each tool
- Modify: `packages/agent-core/src/tools/builtin/index.ts`
- Modify: `packages/agent-core/src/agent/tool/index.ts`
- Create: `packages/agent-core/test/tools/review.test.ts`

**Tasks:**

- [x] Implement reviewer tools:
  - `GetAssignment({})`
  - `GetChangedFiles({ include?, statuses? })`
  - `ReadPatch({ path, hunk_id?, context_lines? })`
  - `ReadFileVersion({ path, version?, ref?, line_offset?, n_lines? })`
  - `UpdateProgress({ status, summary?, blocker? })`
  - `AddComment({ severity, path, line, title, body, evidence?, suggested_fix? })`
- [x] Implement reconciliator tools:
  - `GetComments({ status?, scope?, paths?, include_sources? })`
  - `GetCommentEvidence({ comment_id })`
  - `MergeComments({ source_comment_ids, severity, path, line, title, body, evidence?, suggested_fix? })`
  - `DismissComment({ comment_id, reason, summary, merged_comment_id? })`
- [x] Keep descriptions direct and imperative. Avoid names or prose that make tools sound like general editing tools.
- [x] Make all tools return structured JSON strings where the model needs machine-readable missing requirements.
- [x] Register review tools only when the agent has an active review facade. They should not appear in normal tool lists.
- [x] Test schemas, missing active assignment errors, coverage rejection, merge provenance, and dismissal reasons.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/tools/review.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/tools/review.test.ts` because Vitest runs from the package directory.

## Phase 4: Profiles and Read-Only Enforcement

Purpose: make reviewer and reconciliator workers safe by default.

**Files:**

- Create: `packages/agent-core/src/profile/default/reviewer.yaml`
- Create: `packages/agent-core/src/profile/default/reconciliator.yaml`
- Modify: `packages/agent-core/src/profile/default/agent.yaml`
- Modify: `packages/agent-core/src/profile/default.ts`
- Create: `packages/agent-core/src/agent/permission/policies/review-mode-guard-deny.ts`
- Modify: `packages/agent-core/src/agent/permission/policies/index.ts`
- Modify: `packages/agent-core/test/profile/default-agent-profiles.test.ts`
- Create or extend: `packages/agent-core/test/tools/review-mode-hard-block.test.ts`

**Tasks:**

- [x] Add `reviewer` profile with tools:
  - `GetAssignment`
  - `GetChangedFiles`
  - `ReadPatch`
  - `ReadFileVersion`
  - `UpdateProgress`
  - `AddComment`
  - `Grep`
  - `Glob`
- [x] Add `reconciliator` profile with tools:
  - `GetComments`
  - `GetCommentEvidence`
  - `MergeComments`
  - `DismissComment`
  - `UpdateProgress`
  - `ReadPatch`
  - `ReadFileVersion`
- [x] Register both as subagent profiles in `agent.yaml`.
- [x] Add both YAML sources to `packages/agent-core/src/profile/default.ts`.
- [x] Add `ReviewModeGuardDenyPermissionPolicy` before auto/yolo approval policies. It should deny:
  - `Write`
  - `Edit`
  - `Bash`
  - `Agent`
  - `AgentSwarm`
  - `AskUserQuestion`
  - task and cron mutation tools
  - unknown non-review tools while a review assignment is active
- [x] Test that review workers cannot mutate files even when parent permission mode is `auto` or `yolo`.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/profile/default-agent-profiles.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/profile/default-agent-profiles.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/tools/review-mode-hard-block.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/tools/review-mode-hard-block.test.ts` because Vitest runs from the package directory.

## Phase 5: Background Injection and Worker Driving

Purpose: make review workers recover after compaction and keep running until required work is complete.

**Files:**

- Create: `packages/agent-core/src/agent/injection/review.ts`
- Modify: `packages/agent-core/src/agent/injection/manager.ts`
- Create: `packages/agent-core/src/review/worker-driver.ts`
- Modify: `packages/agent-core/src/session/subagent-host.ts`
- Create: `packages/agent-core/test/agent/injection/review.test.ts`
- Create: `packages/agent-core/test/review/worker-driver.test.ts`

**Tasks:**

- [x] Implement `ReviewInjector` that injects shared review background and the active assignment for reviewer and reconciliator workers.
- [x] Re-inject background after context clear and compaction.
- [x] Add a review-specific worker driver that:
  - starts a subagent with a review assignment
  - waits for a turn to complete
  - audits progress and coverage
  - continues the same subagent with missing requirements
  - stops when status is `complete` or `blocked`
  - fails after a bounded number of non-progress continuations
- [x] Keep the driver internal to review runtime. Do not route reviewer orchestration through the generic model-facing `Agent` tool.
- [x] Test compaction re-injection and missing-coverage continuation.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/agent/injection/review.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/agent/injection/review.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/worker-driver.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/review/worker-driver.test.ts` because Vitest runs from the package directory.

## Phase 6: Standard Review Runtime

Purpose: deliver the first end-to-end useful review mode.

**Files:**

- Create: `packages/agent-core/src/review/prompts.ts`
- Create: `packages/agent-core/src/review/orchestrator.ts`
- Create: `packages/agent-core/test/review/orchestrator-standard.test.ts`
- Modify: `packages/agent-core/src/session/rpc.ts`
- Modify: `packages/agent-core/src/rpc/core-api.ts`
- Modify: `packages/agent-core/src/rpc/core-impl.ts`

**Tasks:**

- [x] Implement `startReview(input)` for `standard` intensity.
- [x] Build review background packet from target, focus, diff stats, changed file manifest, and relevant repository instructions.
- [x] Create one reviewer assignment covering all changed files.
- [x] Run one `reviewer` worker with the worker driver.
- [x] Convert audited candidate comments directly into final comments for Standard.
- [x] Emit a final assistant-facing review summary.
- [x] Add RPC method and payload types for:
  - list base refs
  - list commits
  - preview target
  - start review
  - cancel review
- [x] Gate all review methods behind `code_review`.
- [x] Test no-finding, one-finding, missing-coverage retry, and cancellation paths.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/orchestrator-standard.test.ts`. Executed as `pnpm --filter @moonshot-ai/agent-core exec vitest run test/review/orchestrator-standard.test.ts` because Vitest runs from the package directory.

## Phase 7: SDK Review API

Purpose: let apps call review features without importing core.

**Files:**

- Modify: `packages/node-sdk/src/types.ts`
- Modify: `packages/node-sdk/src/rpc.ts`
- Modify: `packages/node-sdk/src/session.ts`
- Create: `packages/node-sdk/test/session-review.test.ts`

**Tasks:**

- [x] Add public SDK input and output types:
  - `ReviewScopeInput`
  - `ReviewTargetPreview`
  - `ReviewStartInput`
  - `ReviewBaseRef`
  - `ReviewCommit`
- [x] Add `Session` methods:
  - `listReviewBaseRefs()`
  - `listReviewCommits()`
  - `previewReviewTarget(input)`
  - `startReview(input)`
  - `cancelReview()`
- [x] Add RPC passthrough methods in `SDKRpcClientBase`.
- [x] Test that SDK methods call core RPC with `sessionId`.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`.
- [x] Run `pnpm --filter @moonshot-ai/kimi-code-sdk exec vitest run packages/node-sdk/test/session-review.test.ts`. Executed as `pnpm --filter @moonshot-ai/kimi-code-sdk exec vitest run test/session-review.test.ts` because Vitest runs from the package directory.

## Phase 8: TUI `/review` Command and Selectors

Purpose: expose Standard review through the Codex-style command flow.

**Files:**

- Modify: `apps/kimi-code/src/tui/commands/registry.ts`
- Modify: `apps/kimi-code/src/tui/commands/dispatch.ts`
- Modify: `apps/kimi-code/src/tui/commands/index.ts`
- Create: `apps/kimi-code/src/tui/commands/review.ts`
- Create: `apps/kimi-code/src/tui/utils/review-options.ts`
- Extend tests: `apps/kimi-code/test/tui/commands/registry.test.ts`
- Create: `apps/kimi-code/test/tui/commands/review.test.ts`

**Tasks:**

- [x] Register `/review` as idle-only and hidden or blocked when `code_review` is disabled.
- [x] Parse `/review <focus>` as optional free-form focus text.
- [x] Add scope selector:
  - `Working tree`
  - `Current branch`
  - `Single commit`
- [x] Add base ref selector for `Current branch`.
- [x] Add commit selector for `Single commit`.
- [x] Call `session.previewReviewTarget()` after target selection and show `Reviewing N files: +A -D`.
- [x] Add intensity selector with labels:
  - `Standard   Single reviewer for everyday changes.`
  - `Thorough   Multiple focused reviewers before opening a PR.`
  - `Deep       Swarm-backed review for risky or large changes.`
- [x] For this phase, allow only `Standard` to start. Show “coming soon” notice for `Thorough` and `Deep` until later phases land.
- [x] Start review through `session.startReview()`.
- [x] Use `ChoicePickerComponent` and follow `.agents/skills/write-tui/DESIGN.md`.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/kimi-code exec vitest run apps/kimi-code/test/tui/commands/review.test.ts`. Executed with `test/tui/commands/review.test.ts test/tui/commands/registry.test.ts test/tui/commands/resolve.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/kimi-code exec vitest run apps/kimi-code/test/tui/commands/registry.test.ts`. Executed with `test/tui/commands/review.test.ts test/tui/commands/registry.test.ts test/tui/commands/resolve.test.ts` because Vitest runs from the package directory.

## Phase 9: Review Progress Events, TUI Display, and Cancellation

Purpose: make active reviews visible and stoppable without corrupting results.

**Files:**

- Modify: `packages/agent-core/src/rpc/events.ts`
- Modify: `packages/node-sdk/src/events.ts`
- Modify: `apps/kimi-code/src/tui/controllers/session-event-handler.ts`
- Modify: `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts`
- Create: `apps/kimi-code/src/tui/components/messages/review-progress.ts`
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts`
- Create: `apps/kimi-code/test/tui/controllers/session-event-handler-review.test.ts`
- Create: `apps/kimi-code/test/tui/components/messages/review-progress.test.ts`

**Tasks:**

- [x] Add review events:
  - `review.started`
  - `review.assignment.started`
  - `review.assignment.progress`
  - `review.comment.added`
  - `review.comment.merged`
  - `review.comment.dismissed`
  - `review.completed`
  - `review.cancelled`
  - `review.failed`
- [x] Render a compact review progress block in the transcript or activity area.
- [x] During an active review, make `Esc` show confirmation:
  - title: `Stop review?`
  - body: `Running reviewers will be cancelled. Partial findings may be lost.`
- [x] On confirmation, call `session.cancelReview()`.
- [x] Ensure selector-stage `Esc` still cancels normally.
- [x] Avoid showing partial comments as complete review output after cancellation.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/kimi-code exec vitest run apps/kimi-code/test/tui/controllers/session-event-handler-review.test.ts`. Executed with `test/tui/controllers/session-event-handler-review.test.ts test/tui/components/messages/review-progress.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/kimi-code exec vitest run apps/kimi-code/test/tui/components/messages/review-progress.test.ts`. Executed with `test/tui/controllers/session-event-handler-review.test.ts test/tui/components/messages/review-progress.test.ts` because Vitest runs from the package directory.

## Phase 10: Thorough Review and Single Reconciliator

Purpose: add multi-perspective review with exactly one reconciliator.

**Files:**

- Modify: `packages/agent-core/src/review/orchestrator.ts`
- Modify: `packages/agent-core/src/review/prompts.ts`
- Create: `packages/agent-core/test/review/orchestrator-thorough.test.ts`
- Modify: `apps/kimi-code/src/tui/commands/review.ts`
- Modify: `apps/kimi-code/test/tui/commands/review.test.ts`

**Tasks:**

- [x] Implement perspective generation for `Thorough`.
- [x] Show generated perspectives in the TUI before launch.
- [x] Launch one `reviewer` worker per perspective.
- [x] Require each reviewer to review all changed file patches.
- [x] Launch exactly one `reconciliator` after all focused reviewers complete.
- [x] The reconciliator should inspect all candidate comments from all focused reviewers.
- [x] Require every source comment to be merged or dismissed.
- [x] Emit final review from merged comments.
- [x] Enable `Thorough` in the intensity selector.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/orchestrator-thorough.test.ts`. Executed with `test/review/orchestrator-thorough.test.ts test/review/runtime.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/kimi-code exec vitest run apps/kimi-code/test/tui/commands/review.test.ts`. Executed as `pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/review.test.ts` because Vitest runs from the package directory.

## Phase 11: Deep Review and Grouped Reconciliators

Purpose: add swarm-backed review with overlapping coverage and grouped reconciliation.

**Files:**

- Modify: `packages/agent-core/src/review/orchestrator.ts`
- Create: `packages/agent-core/src/review/coverage-matrix.ts`
- Create: `packages/agent-core/test/review/orchestrator-deep.test.ts`
- Create: `packages/agent-core/test/review/coverage-matrix.test.ts`
- Modify: `apps/kimi-code/src/tui/commands/review.ts`

**Tasks:**

- [x] Implement coverage matrix creation for changed files.
- [x] Partition work by file group and perspective.
- [x] Ensure every changed file is assigned to at least two workers.
- [x] Require Deep workers to read assigned changed files in full through `ReadFileVersion`.
- [x] Launch multiple reconciliators grouped by perspective or subsystem.
- [x] Perspective reconciliator rule: combine comments from all subagents with the same perspective across all assigned file groups.
- [x] Subsystem reconciliator rule: combine comments from all subagents that reviewed that subsystem across all perspectives assigned to that subsystem.
- [x] Coordinator emits final review from merged comments.
- [x] Enable `Deep` in the intensity selector.

**Verification:**

- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/coverage-matrix.test.ts`. Executed with `test/review/coverage-matrix.test.ts test/review/orchestrator-deep.test.ts` because Vitest runs from the package directory.
- [x] Run `pnpm --filter @moonshot-ai/agent-core exec vitest run packages/agent-core/test/review/orchestrator-deep.test.ts`. Executed with `test/review/coverage-matrix.test.ts test/review/orchestrator-deep.test.ts` because Vitest runs from the package directory.

## Phase 12: Final Docs, Changeset, and Full Verification

Purpose: prepare the feature for review.

**Files:**

- Modify docs through `gen-docs` if the user-facing `/review` behavior is enabled in this branch.
- Add changeset under `.changeset/` through `gen-changesets`.

**Tasks:**

- [x] Run `gen-docs` skill if `/review` is user-visible. Updated bilingual slash-command and experimental-flag docs; `docs/scripts/sync-changelog.mjs` was not present, so changelog sync could not run.
- [x] Run `gen-changesets` skill. Use `minor` unless the final behavior is judged breaking and the user explicitly confirms a major bump.
- [x] Run package checks:
  - `pnpm --filter @moonshot-ai/agent-core run typecheck`
  - `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`
  - `pnpm --filter @moonshot-ai/kimi-code run typecheck`
- [x] Run focused tests from all previous phases.
- [x] Run `pnpm test` if time allows.
- [x] Manually smoke test:
  - `/review` working tree with one small change
  - `/review focus on security` current branch against base
  - cancellation during active review
  - Thorough with duplicate comments
  - Deep with at least one file covered by multiple workers
  - Covered by focused command, event, and orchestrator smoke tests rather than a live model-backed TUI session.

## Rollout Strategy

- Keep `code_review` default off until Standard, TUI flow, cancellation, and docs are complete.
- Enable only `Standard` internally first.
- Enable `Thorough` only after reconciliator provenance is tested.
- Enable `Deep` only after coverage matrix and grouped reconciliators are tested.
- Do not add auto-fix, GitHub PR comments, or separate `/security-review` in this implementation.

## Self-Review Checklist

- [x] `/review <focus>` maps to the user-facing flow in `plans/code-review-command-design.md`.
- [x] Review tool names match `plans/orchestration.md`: no `Review*` prefix in model-facing names.
- [x] The model never needs to pass `review_id` or `assignment_id`.
- [x] Reviewer workers cannot mutate files or launch more agents.
- [x] Background is injected at reviewer start and after compaction.
- [x] `Thorough` uses exactly one reconciliator.
- [x] `Deep` uses grouped reconciliators by perspective or subsystem.
- [x] Every final multi-agent comment has source comment provenance.
- [x] `apps/kimi-code` calls only the SDK, never `@moonshot-ai/agent-core` directly.
