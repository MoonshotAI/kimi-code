# Code review findings — feat/code-review

Run: `/code-review xhigh` against `git diff main...HEAD` (10,671 insertions across 89 source files).

Method: 9 independent finder angles (line-by-line, removed-behavior, cross-file tracer, language pitfalls, wrapper/proxy, reuse, simplification, efficiency, altitude) surfaced ~52 raw candidates. Cross-angle agreement stood in for the 1-vote verifier pass (verifier subagents completed but their notifications were not delivered). Findings below each had ≥1 angle hit; most had 2–4.

Ranked most-severe first. Cap of 15.

---

## 1. Non-progress signature uses runtime-wide state

- **File:** `packages/agent-core/src/review/worker-driver.ts:108` (mirrored in `packages/agent-core/src/review/orchestrator.ts:546`)
- **Summary:** The `audit.signature` used to detect "no progress" includes runtime-wide `getComments().length` / `getMergedComments().length` / `getDismissedComments().length`, not per-assignment.
- **Failure:** Thorough/deep review with N parallel workers — worker A is genuinely stuck (no UpdateProgress, no AddComment) for 3 continuations, but sibling workers add comments between A's audits. A's signature changes each cycle, `nonProgressContinuations` resets to 0, the `DEFAULT_MAX_NON_PROGRESS_CONTINUATIONS=3` safety cap never trips, and A is re-resumed indefinitely until parent abort fires.

## 2. `recordPatchRead` marks complete on hunk-filtered read

- **File:** `packages/agent-core/src/tools/builtin/review/read-patch.ts:61` (and `packages/agent-core/src/review/coverage.ts:38-43`)
- **Summary:** `recordPatchRead` flips `file.patchRead=true` even when ReadPatch was filtered to a single `hunk_id`. `patchHunkIds` is tracked but never consulted by `hasRequiredCoverage('patch')`, which only checks the boolean.
- **Failure:** Reconciliator (`requiredCoverage:'patch'`) calls `ReadPatch({path:'foo.ts', hunk_id:'hunk-1'})` on a 5-hunk file, then `UpdateProgress({status:'complete'})`. The runtime accepts complete; the other 4 hunks are silently skipped and the assignment is reported as fully reviewed.

## 3. `GetComments` dismissed branch leaks scope

- **File:** `packages/agent-core/src/tools/builtin/review/get-comments.ts:58`
- **Summary:** The `includePath` filter (enforcing `scope='assigned'` and the `paths` arg) is applied to candidate and merged branches but NOT to the dismissed branch.
- **Failure:** A reviewer assigned to `[src/a.ts, src/b.ts]` calls `GetComments({scope:'assigned'})`. `dismissed_comments` returns dismissals from sibling reviewers' files too, leaking cross-assignment context the scope filter was supposed to prevent.

## 4. `cancelReview` wipes completed-review state

- **File:** `packages/agent-core/src/session/index.ts:457`
- **Summary:** `cancelReview` unconditionally calls `this.review.clear()` when `activeReviewOrchestrator` is undefined. After a normal completion the orchestrator's `finally` unhooks itself, so any subsequent `cancelReview` wipes the maps that `finishReview()` preserved — and emits no `review.cancelled` event.
- **Failure:** Review completes; UI receives `review.completed` and renders comments. User presses Ctrl+C / SDK retries cancelReview. `activeReviewOrchestrator` is undefined → `runtime.clear()` wipes assignments/comments/merged/dismissed/coverage. Subsequent `GetComments` or re-render shows empty data with no terminal event.

## 5. Concurrent `startReview` orphans the first orchestrator

- **File:** `packages/agent-core/src/session/index.ts:429`
- **Summary:** `startReview` gates only on `hasActiveTurn` (which iterates `agent.turn.hasActiveTurn`); review state does not set `agent.turn`, so two concurrent `startReview` calls pass the guard and the second overwrites `activeReviewOrchestrator`.
- **Failure:** User double-taps `/review`, or an SDK client retries on a slow first call. Both `ReviewOrchestrator` instances spawn reviewer subagents in parallel; `cancelReview` only cancels the second; the first runs to completion emitting `review.*` events against a UI state assuming a single intensity.

## 6. `recordFileVersionRead` overwrites `totalLines`

- **File:** `packages/agent-core/src/review/coverage.ts:48`
- **Summary:** `recordFileVersionRead` unconditionally overwrites `file.totalLines` on every call while merging `fileRanges` across calls. Reading two versions of the same file (base vs current) — explicitly suggested by `prompts.ts` — leaves `totalLines` reflecting only the last read while ranges aggregate from both.
- **Failure:** Worker reads current (totalLines=999, ranges=[1..999]) then base partial (line_offset=1, n_lines=500, totalLines=1000). Stored: ranges=[1..999], totalLines=1000. `isFullFileCovered` returns false; `UpdateProgress('complete')` is rejected even though the assigned version was fully read.

## 7. `current_branch` 3-dot diff vs base-ref tip asymmetry

- **File:** `packages/agent-core/src/review/git-target.ts:130` and `packages/agent-core/src/tools/builtin/review/support.ts:142`
- **Summary:** `current_branch` target uses `${baseRef}...${headRef}` (merge-base anchored), but `readFileVersionForTarget(version:'base')` resolves the base side via `git show baseRef:path` — content at the TIP of baseRef, not the merge-base.
- **Failure:** User reviews a feature branch where main has advanced since divergence. Reviewer reads a hunk citing 'line 42 was X' and calls `ReadFileVersion(version:'base')` for context — the result is main's tip (same logical content at a different line, or file renamed/deleted on main). Any comment anchored to base-side line numbers points to the wrong place or fails validation.

## 8. `previewStatus` banner not cleared on error

- **File:** `apps/kimi-code/src/tui/commands/review.ts:50`
- **Summary:** The `previewStatus` handle from `host.showTransientStatus` is dismissed only on three explicit happy/cancel paths and not wrapped in try/finally; any throw from `promptReviewIntensity`, `session.previewReviewPlan`, or `promptReviewPerspectiveConfirmation` leaves the banner pinned forever.
- **Failure:** User runs `/review` on a branch where `previewReviewPlan` throws (network failure, RPC schema mismatch). Exception bubbles out of `handleReviewCommand`; the "Reviewing N files: +X -Y" transient remains in the transcript until session restart.

## 9. Stuck deep-swarm worker aborts all siblings and wipes findings

- **File:** `packages/agent-core/src/review/orchestrator.ts:489`
- **Summary:** `runDeepReviewerSwarm` throws and aborts the controller the moment ONE reviewer signature stalls. Siblings that already produced valid candidate comments are cancelled mid-flight, and the `catch` path calls `runtime.clear()`, wiping the partial findings.
- **Failure:** 8 reviewer assignments. Reviewer #3 emits the same audit signature 3 cycles. Orchestrator throws 'Review worker assignment-3 made no progress'; the controller cascades, reviewers #1/#2/#4-#8 are killed; `runtime.clear()` wipes their comments. User sees `review.failed` with no findings instead of 7-of-8 partial results.

## 10. `missingReconciliation` throws crashes the audit loop

- **File:** `packages/agent-core/src/review/runtime.ts:213`
- **Summary:** `missingReconciliation` calls `requireComment(sourceCommentId)`, which throws `ReviewRuntimeError` on unknown ids. `auditAssignment` calls `missingReconciliation` every poll, so a stale or unregistered `sourceCommentId` propagates as an uncaught throw that kills the review.
- **Failure:** A reconciliator assignment is created with `sourceCommentIds` containing an id whose underlying comment was dismissed and pruned (race between `dismissComment` and `createReconciliatorAssignment`). The next audit cycle throws 'Review comment was not found' instead of surfacing the missing comment as unreconciled coverage.

## 11. Thorough reconciliator role race in session event handler

- **File:** `apps/kimi-code/src/tui/controllers/session-event-handler.ts:411`
- **Summary:** `handleReviewAssignmentProgress` looks up role via `reviewAssignmentRoles.get(id) ?? 'reviewer'`. If `review.assignment.progress` arrives before `review.assignment.started` (reorder, or a fast-finishing reconciliator), the role lookup falls back to `'reviewer'` and is suppressed under the thorough-mode reviewer filter.
- **Failure:** Thorough run: reconciliator's terminal progress event is reordered before its assignment.started. Role classifies as reviewer, suppression branch returns; the user never sees the reconciliation-complete state and the run appears to hang.

## 12. `swarmIndex` is 1-indexed, not 0-indexed

- **File:** `packages/agent-core/src/review/orchestrator.ts:341`
- **Summary:** `swarmIndex` is read from `assignmentIdsByKey.size` AFTER `.set()`, making it 1..N rather than 0..N-1.
- **Failure:** `createDeepCoverageMatrix` yields 8 reviewer specs with `swarmIndex` 1..8. If the swarm UI's `items[swarmIndex]` lookup is 0-based (as elsewhere in the subagent renderer), index 0 reads undefined for the first reviewer and the labels shift one row off.

## 13. `ChoicePickerComponent` setInterval leak on bypassed teardown

- **File:** `apps/kimi-code/src/tui/components/dialogs/choice-picker.ts:99`
- **Summary:** Wave-label `setInterval` is cleared only in this component's `dispose()`, which runs only via `KimiTUI.disposeEditorReplacement` (mountEditorReplacement / restoreEditor). Any teardown path that bypasses those — crash, session reset, exception between mount and onSelect — leaks the interval.
- **Failure:** Picker is open when the session errors and the editor container is rebuilt outside the normal restore path; interval keeps firing `requestRender` every 120 ms for the lifetime of the process.

## 14. `listUntrackedFileChanges` OOMs on large untracked files

- **File:** `packages/agent-core/src/review/git-target.ts:277`
- **Summary:** `listUntrackedFileChanges` calls `kaos.readBytes(filePath)` for every untracked file with no size cap, then `bytes.toString('utf8')` to count lines — large untracked artefacts are buffered fully into memory just to populate the preview.
- **Failure:** User runs `/review` on a working tree containing a multi-GB untracked database dump, build output, or an accidental node_modules; the preview phase OOMs the Node process before the scope picker returns.

## 15. Missing `--` separator in `runGit` invocations (CVE-2018-17456 class)

- **File:** `packages/agent-core/src/review/git-target.ts:442` (and `support.ts`)
- **Summary:** `runGit` invocations pass user-influenced refs as positional args without a `--` end-of-options separator; a ref starting with `-` (e.g. `--upload-pack=cmd`) is parsed by git as an option (known CVE class).
- **Failure:** A malicious or accidentally-pasted ref name beginning with `--upload-pack=…` reaches `resolveCommitRef` or `diffFileChanges` via the TUI picker or RPC. Git interprets it as an option to commands that respect upload-pack hooks. Mitigation: insert `--` before every user-supplied ref.

---

## Cut by the 15-finding cap (cleanup / altitude — strong signals worth keeping in mind)

- **3× duplicated `runGit` helpers:** `packages/agent-core/src/review/git-target.ts`, `packages/agent-core/src/tools/builtin/review/support.ts`, and `packages/agent-core/src/session/git-context.ts` each re-implement the same kaos.exec timeout/kill/drain pattern. A single shared helper avoids 3-way drift.
- **Review tool names listed in 4 places:** `agent/permission/policies/review-mode-guard-deny.ts`, `agent/permission/policies/review-mode-tool-approve.ts`, `agent/tool/index.ts` (10 hand-pasted instantiations), and `apps/kimi-code/src/tui/components/messages/tool-renderers/registry.ts`. A `tool.category === 'review'` capability flag generalises all four.
- **Duplicated TUI helpers:** `apps/kimi-code/src/tui/components/messages/tool-renderers/review.ts` re-implements `countLabel`, `lineRangeLabel`, `formatReviewRefForDisplay`, `joinReviewDetails`, `FULL_GIT_OBJECT_ID_RE`, and a private `stringArg` helper that duplicates `strArg` from `types.ts`.
- **`ReviewFinalComment` is structurally identical to `ReviewMergedComment`** (`packages/agent-core/src/review/types.ts:184`); the conversion is the identity function.
- **AbortError detected via brittle `message.toLowerCase().includes('aborted')`** in `apps/kimi-code/src/tui/commands/review.ts:209`; prefer `error.name === 'AbortError'` or signal check.
- **`Session` is becoming a god object for review** — 7 review-specific RPC methods, an `activeReviewOrchestrator` field, and a `review` runtime. Most of the surface belongs on the orchestrator with `Session.getReviewOrchestrator()` as the single entry point.

---

_Generated by `/code-review xhigh`, 2026-06-12._
