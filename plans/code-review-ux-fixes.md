# Code Review UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the review-mode UX problems found during real `/review` use, with special attention to cancellation, model errors, selector clarity, multi-agent visibility, and `AgentSwarm` display.

**Architecture:** Keep review orchestration in `packages/agent-core`, SDK event types in `packages/node-sdk` / `packages/protocol`, and all terminal display behavior in `apps/kimi-code/src/tui`. Treat `Deep Review` as the user-facing name for the `AgentSwarm` review intensity. The TUI should show one clear review surface instead of competing progress blocks.

**Tech Stack:** TypeScript, Vitest, pi-tui components, existing review runtime, existing `AgentSwarm` progress component, existing slash-command and selector infrastructure.

---

## Problem List

The current implementation has these user-visible issues:

- Cancelling interactive `/review` before review starts leaves the diff summary on screen, for example `Reviewing 112 files: +9071 -39.`
- Model/provider errors during review, such as `429`, can crash the whole program instead of ending review mode and returning to the chat.
- Selector choices are too dense because there is no blank line between options.
- `Deep` review starts an `AgentSwarm` progress view, but the user mostly sees a long live list of `Reviewer started` entries. The list refreshes while running, so it is hard to scroll back to the `AgentSwarm` UI.
- Multi-agent modes do not show the generated review perspectives before launch.
- `/review` is described as "Review Git Changes", which is too narrow and confusing. It should be presented as code review of a selected local change set.
- The "What to review" selector is missing "all commits ahead of upstream branch".
- The "What to review" selector needs richer context: working tree should show uncommitted-change counts; current branch should show the relevant commit message and short hash.
- `Deep` should be renamed to `Deep Review` in user-facing UI.
- The `Deep Review` option in the review-intensity selector should have a wave color animation across its characters.
- `ReadFileVersion` tool labels should show short hashes instead of full hashes.
- `Thorough` review does not make it clear how many reviewer agents are running in parallel.

## Issue Reports

### Issue 1: Selector-stage cancellation leaves the review preview line

**Issue:** Cancelling interactive `/review` before the review actually starts leaves a normal transcript line behind, such as `Reviewing 112 files: +9071 -39.` The line appears after the review target has been selected and previewed, but before the user chooses an intensity. If the user presses `Esc` on the intensity selector, the review is cancelled from the user's point of view, but the transcript still says it was reviewing that change set. This is misleading because no reviewer agent was started, no review mode should be considered active, and the line reads like durable progress rather than a temporary preview.

**What the code does today:** `handleReviewCommand()` first asks `promptReviewScope()` what to review. For the current branch and single commit paths, it may ask a secondary selector through `resolveReviewTargetFromScope()`. It then calls `session.previewReviewTarget(target)`. If the preview reports at least one changed file, the command calls `host.showStatus()` with a message like `Reviewing ${formatReviewStats(preview.stats)}.`. Only after that permanent status write does it open `promptReviewIntensity()`. The picker cancellation path is simple: `ChoicePickerComponent` handles `Esc`, calls `onCancel`, and `promptChoice()` responds by calling `host.restoreEditor()` and resolving `undefined`. Back in `handleReviewCommand()`, `if (intensity === undefined) return;` exits the command. There is no cleanup step between the cancellation return and the earlier `host.showStatus()` call.

**Why the line remains:** `host.showStatus()` is not a transient prompt hint. In `KimiTUI`, it creates a `StatusMessageComponent` and appends it to `state.transcriptContainer`. Unlike `appendTranscriptEntry()`, this path does not also write a `TranscriptEntry`, but it is still durable in the visible transcript container until the transcript is cleared or the child is explicitly removed. `restoreEditor()` only swaps the editor area back from the selector to the normal editor; it does not touch transcript children. This explains the user's exact observation: selector cancellation restores input, but the already-mounted status component remains. The nearby codebase has lower-level precedents for explicit transcript mutation, such as `SessionReplayController.removeToolCall()` removing a child from `state.transcriptContainer.children` and invalidating the container, and `SessionEventHandler.finalizeMcpServerStatusRow()` replacing a spinner child with a final status row. That means the TUI can support temporary rows, but `/review` does not currently model this preview as temporary.

**What I will do:** Introduce an explicit transient-review-preview mechanism for this command path instead of using plain `showStatus()` for the pre-launch preview. The smallest clean shape is a host-level helper that can mount a temporary status row and return a disposal handle, for example `showTransientStatus(message, color?) => { clear(): void }`, or a review-specific helper local to the command if the project owners prefer not to widen `SlashCommandHost` yet. The command should store that handle after the preview is shown. If intensity selection is cancelled, the command clears the preview before returning. If the user selects an intensity and the review starts, the preview should either be cleared immediately before `startReview()` or be replaced by the real review progress spinner and later `review.started` event. If `previewReviewTarget()` returns no changes, the existing `No changes to review.` permanent status is still correct because it is the final command result, not a cancelled preview. If cancelling the first "What to review" selector or the secondary base-ref/commit selector happens before the preview call, no cleanup is needed because no preview line has been mounted yet.

**Test plan for this issue:** Add a focused test to `apps/kimi-code/test/tui/commands/review.test.ts` that selects a target, waits for the intensity picker, sends `Esc`, awaits the command, and verifies that the preview row is removed or, at the host-test level, that the returned transient-status handle was cleared. The test should also assert that `session.startReview` was not called and that `host.restoreEditor` ran for the cancelled picker. A second narrow test should cover the successful path: after selecting an intensity, the transient preview must not remain as a stale row next to the active review spinner or final review result. If a generic helper is added to `SlashCommandHost`, update the host mock in this test file and any nearby slash-command test utilities. Manual verification should run `/review`, choose a target with changes, press `Esc` at "Review intensity", and confirm that the transcript has no `Reviewing N files: +A -D.` line afterwards.

### Issue 2: Model/provider errors must end review mode gracefully

**Issue:** Model and provider errors during review, especially retryable provider failures such as `429`, should not crash the program or leave the user trapped in review mode. The user should see one clear message such as `Review stopped` with a useful reason, then return to the normal chat state. Partial findings should not be presented as a completed review. This matters more for review than a normal single-agent turn because `Thorough` and `Deep Review` can run several child agents at once. A single child failure can happen while other reviewer or reconciliator agents are still active.

**What the code does today:** The `/review` command starts a local progress spinner, awaits `host.requireSession().startReview(input)`, and catches a rejected promise. On rejection, it stops the spinner and calls `host.showError()` with `Review failed: ${message}`, except for abort-like messages, which become `Review cancelled.` The slash-command dispatcher also has a broad catch around built-in commands, so synchronous command errors should become an error row rather than an uncaught exception. In the event path, `SessionEventHandler` handles `review.failed` by setting `state.reviewActive = false`, finishing the Deep Review `AgentSwarm` synthetic tool result as an error, and appending a `Review failed` progress entry. In core, `ReviewOrchestrator.start()` catches errors, emits `review.failed` for non-cancellation failures, rethrows, and finally calls `runtime.finishReview()` when a run is active. `Session.startReview()` also clears `activeReviewOrchestrator` in a `finally`. The RPC layer can serialize thrown provider errors with `toKimiErrorPayload()`, and that serializer already recognizes provider status errors such as `429` as `provider.rate_limit`.

**Why this is still not robust:** The failure contract is split across three surfaces that do not share the same error shape. The core `review.failed` event only carries a raw `message`; it does not carry a `KimiErrorPayload`, so the TUI event path loses the provider code, retryability, status code, and request id that the RPC rejection path can preserve. This is why a rate-limit failure can look like a generic worker crash in the review transcript. The command catch can then show a second, differently formatted `Error: Review failed: [provider.rate_limit] ...` row, so the user can see both a review-progress failure and a command-level failure. More importantly, concurrent review phases are not explicitly failed as a group. `Thorough` launches reviewers with `Promise.all()`, and `Deep Review` launches reconciliators with `Promise.all()` after the swarm-backed reviewer phase. If one worker rejects, the orchestrator fails fast and enters its catch/finally path, but it does not clearly abort sibling workers or wait for every active child to settle before finishing review runtime state. Even if JavaScript's `Promise.all()` attaches rejection handlers to all input promises, those sibling child agents may continue emitting subagent events after review mode has been marked failed. Deep reviewer swarm uses `SubagentBatch`, which is more defensive and returns per-task failed results, but it currently turns provider failures into strings before `ReviewOrchestrator` throws a generic `Error`, again losing machine-readable provider classification. Existing tests cover successful Standard, Thorough, and Deep review, cancellation, progress rendering, and some non-progress failure cases. They do not simulate a provider rate-limit or model error during Standard, Thorough, Deep reviewer swarm, or Deep reconciliation and then prove that `review.failed` is emitted, `reviewActive` is false, runtime state is cleared, sibling child work is stopped, and the chat remains usable.

**What I will do:** Define a single graceful failure contract for review. Extend `ReviewFailedEvent` to include an optional `error: KimiErrorPayload` while keeping `message` for compatibility. In `ReviewOrchestrator.start()`, normalize non-cancellation errors through `toKimiErrorPayload(error)` before emitting `review.failed`. Preserve provider codes for direct worker failures and update `SubagentBatch` / Deep reviewer swarm result handling so rate-limit failures are not flattened to plain strings before the review boundary sees them. For concurrent phases, add a review-owned failure path that aborts the orchestrator signal for sibling workers, waits for all active worker promises to settle, and only then finishes runtime state and returns control to `Session.startReview()`. In the TUI, make `handleReviewFailed()` format `event.error` with the existing `formatErrorPayload()` helper and show user-facing copy like `Review stopped` for provider errors. The command-level catch should still stop its spinner, but it should avoid printing a second contradictory error if the review failure event already rendered the terminal review state. As a fallback, if the event is not observed, the command catch should set `state.reviewActive = false`, finish any active review UI, and show the same concise failure wording.

**Test plan for this issue:** Add agent-core tests that force the reviewer launcher, reconciliator launcher, and Deep `runQueued()` path to fail with a provider-style rate-limit error. Assert that `review.failed` includes `error.code === 'provider.rate_limit'`, that `runtime.getActiveRun()` is `null`, and that no partial result is returned as complete. Add a concurrent-phase test where one Thorough reviewer fails while another is still pending, then assert the pending worker is aborted and awaited before review shutdown. Add TUI controller tests for `review.failed` with an error payload and verify `reviewActive` becomes false, the Deep Review `AgentSwarm` row is marked failed, and the visible copy uses a friendly review-stopped message. Add command tests where `session.startReview()` rejects with a rehydrated provider error and verify the command does not throw, stops the spinner, does not append a completed review result, and leaves the editor/chat path usable. Manual verification should force a reviewer model `429`, confirm the app stays open, confirm Esc no longer opens the active-review cancellation dialog, and confirm the next normal chat message can be sent.

### Issue 3: Selector options need readable spacing

**Issue:** Review selectors are visually too dense because option blocks are rendered back to back. In the current `/review` scope selector, the line `Current branch` appears immediately after `Review uncommitted tracked and untracked changes.` with no blank line between them. In the intensity selector, `Thorough` appears immediately after `Single reviewer for everyday changes.`, and `Deep` appears immediately after `Multiple focused reviewers before opening a PR.` This makes the next option label look like another description line. The problem becomes more visible in review because scope and intensity options are conceptual choices, not short table rows. The user needs to compare the options quickly and confidently before starting agents.

**What the code does today:** `ChoicePickerComponent.render()` writes the picker header, hint, and one blank line before the list body. For each visible option, it writes a label line, then wraps and writes the optional description lines. After the description loop, it immediately moves to the next option. There is no option-level separator. `Review` uses `promptChoice()` in `apps/kimi-code/src/tui/commands/review.ts`, and `promptChoice()` always constructs a plain `ChoicePickerComponent` with no extra render options. The `REVIEW_SCOPE_CHOICES` and `REVIEW_INTENSITY_CHOICES` entries all have descriptions, so the dense rendering is guaranteed. I also rendered the current scope and intensity selectors from the real component. The output confirms the issue: only the selected row has a pointer; subsequent labels such as `Current branch`, `Single commit`, `Thorough`, and `Deep` are indented exactly like ordinary unselected labels and sit directly under the previous description block. A user can still parse it, but the visual grouping is weak.

**Why a global fix needs care:** `ChoicePickerComponent` is shared by settings, permission mode, update preference, editor, theme, platform, provider catalog, logout provider, plugin remove confirmation, and review prompts. Some of those selectors have rich descriptions and would benefit from more breathing room. Others are dense lists by design. `ThemeSelectorComponent`, `EditorSelectorComponent`, and `PlatformSelectorComponent` are short label-only lists where blank lines would waste space. Provider catalog and logout selectors can be searchable and long; adding blank lines by default would reduce the useful page size and make scrolling more frequent. The list state machine, `SearchableList`, only counts items, not rendered lines, so a global spacing change would also affect how tall an eight-item page becomes. `ModelSelectorComponent` is a useful contrast: it intentionally renders a compact table-like list with aligned columns, and that should remain dense. There is also a positive precedent for spacing: `StartPermissionPromptComponent`, used by goal and swarm permission prompts, always inserts a blank line after each option because each option is a text block with an explanatory description. That is closer to review scope and intensity than the model selector is.

**What I will do:** Add an explicit option to `ChoicePickerComponent`, for example `optionSpacing?: 'compact' | 'relaxed'`, with the default staying `compact`. `relaxed` should insert one blank line between visible option blocks, not after the last visible option and not before the page indicator unless the existing footer spacing already requires it. The blank line should be inserted after the description block when a description exists, and after the label line when a relaxed option has no description. I would then opt the review scope and review intensity selectors into relaxed spacing. I would not apply it automatically to all `ChoicePickerComponent` users in the first pass. The review command can pass this option through `promptChoice()` only for the two primary review decision selectors. Secondary selectors such as `Review against` and `Select a commit` should remain compact because they are searchable lists of refs or commits and may contain more rows. Plugin remove confirmation and permission selectors can be considered later, but they should not be swept into this review-specific fix without checking their rendered height.

**Test plan for this issue:** Extend `apps/kimi-code/test/tui/components/dialogs/choice-picker.test.ts` with an opt-in relaxed-spacing test. It should render two described options and assert there is an empty line between the first option's description and the second option's label. It should also verify the default compact mode preserves the current no-extra-blank behavior, so existing dense selectors do not change by accident. Add a focused `/review` command test that opens the `What to review` picker, renders it, and checks for blank separation between `Working tree` and `Current branch`; then open the intensity picker and check the same spacing between `Standard`, `Thorough`, and `Deep Review` once the rename lands. Add a narrow regression test for a label-only selector such as `ThemeSelectorComponent` or `EditorSelectorComponent` to confirm it remains compact by default. Manual verification should run `/review`, inspect `What to review` and `Review intensity` at normal terminal widths, and confirm each option reads as its own block without pushing the footer off screen.

### Issue 4: Deep Review must keep AgentSwarm as the primary active display

**Issue:** `Deep Review` is backed by `AgentSwarm`, but the running TUI mostly shows a long live transcript list of `Reviewer started` rows. The `AgentSwarm` progress component exists, but it is inserted near the beginning of the review transcript and then pushed upward by many assignment notices. While review is still running, the TUI keeps repainting, so scrolling back to the useful swarm grid is difficult. The user can see the swarm display only after killing the program and scrolling through the now-static terminal buffer. That is the opposite of the intended design: `Deep Review` should make `AgentSwarm` the main live surface for the reviewer phase.

**What the code does today:** `ReviewOrchestrator.start()` emits `review.started` with an `agentSwarm` payload when the selected intensity is `deep`. `SessionEventHandler.handleReviewStarted()` sees that payload, stores the synthetic tool call id `review:deep-agent-swarm`, and calls `SubAgentEventHandler.handleAgentSwarmToolCallStarted()`. That creates an `AgentSwarmProgressComponent`, marks the input complete, adds the component directly to `state.transcriptContainer`, and wires later subagent lifecycle and child-agent events into that component through `SubAgentEventHandler`. The core deep path then calls `createDeepCoverageMatrix()`, creates reviewer assignments for every file group and perspective, and calls `runtime.createAssignment()` for each one. `SessionReviewRuntime.createAssignment()` immediately emits `assignmentStarted()`. The protocol event is `review.assignment.started`, and `SessionEventHandler.handleReviewAssignmentStarted()` unconditionally appends a normal review progress transcript entry with title `Reviewer started` and detail built from the assignment file count and perspective. For a large diff, the matrix creates many reviewer assignments: by default files are grouped in chunks of four and each group receives all deep perspectives. A 112-file diff with four perspectives can therefore create many dozen assignment-start rows before the actual swarm lifecycle has settled on screen.

**Why the `AgentSwarm` UI gets buried:** The swarm progress component and the review progress notices are peers in the transcript container. The component is not a pinned activity pane, nor is it a replacement for the review progress stream. It is appended when `review.started` arrives. Every later `review.assignment.started`, comment, progress, merge, dismissal, completion, or failure appends another transcript child after it. `appendTranscriptEntry()` always pushes to `state.transcriptEntries`, creates a component, adds it to `state.transcriptContainer`, and requests a render. The live terminal normally follows the newest output. So even though the swarm component is active and correctly receives `subagent.spawned`, `subagent.started`, child `assistant.delta`, child tool calls, completions, suspensions, and failures, the user's eye is taken to the newer append-only review rows. The existing AgentSwarm height logic even considers rows after the swarm when calculating available grid height, so the generic component is already designed to coexist with later transcript entries. That is helpful for normal tool use, but it does not solve the review-specific problem where the later entries are mostly duplicate assignment-start noise.

**What should own the display:** During the `Deep Review` reviewer phase, the `AgentSwarmProgressComponent` should own per-reviewer lifecycle display. The separate `review.assignment.started` notices should be suppressed, collapsed, or converted into one aggregate row when the active review has an `agentSwarm` payload. The main transcript can still show durable milestones such as `Review started`, phase changes, `Review finding added`, reconciliation start, completion, cancellation, and failure. It should not append one `Reviewer started` notice per deep reviewer assignment while the swarm grid is the active display for those same workers. The same principle should apply to deep reviewer progress rows that only say a worker became complete or blocked if the information is already visible in the swarm component or can be summarized at phase end. The detailed subagent status should remain inside AgentSwarm, because that is where the user expects to see parallel agent progress.

**What I will do:** Add an explicit review display state in `SessionEventHandler` for active review swarm ownership. When `handleReviewStarted()` receives `event.agentSwarm`, record enough state to know that the deep reviewer phase is being shown through `AgentSwarm`: the tool call id, intensity, and an aggregate count derived from `event.agentSwarm.args.items` when possible. Then change `handleReviewAssignmentStarted()` so reviewer assignments that belong to the active deep reviewer phase do not append individual `Reviewer started` rows. Instead, update an aggregate summary. The first pass can be intentionally simple: append one compact Deep Review summary near the swarm component, for example `Deep Review reviewer phase` with `N reviewer agents`, perspective names if available, and the review stats from the start event; then let the existing `AgentSwarmProgressComponent` render the live grid. If a reconciliator assignment starts after the reviewer swarm completes, the handler can append a compact reconciliation row, because reconciliation is a separate phase and is not represented by the reviewer swarm grid. For `Thorough`, do not use this exact AgentSwarm path, but the same anti-noise idea should later be applied as a compact group of three reviewer agents.

**Implementation notes:** This should stay in the TUI layer unless the protocol needs richer phase metadata. The core event sequence is reasonable: `review.started` announces the run and, for Deep Review, includes the synthetic AgentSwarm call; `review.assignment.started` announces runtime assignments; `subagent.*` events announce actual worker execution. The display bug is that the TUI treats all assignment starts as transcript-worthy rows even when another component already visualizes them. If we need more precision than "deep review with active reviewAgentSwarmToolCallId", we can extend `ReviewAssignmentStartedEvent` later with phase or group metadata, but the existing assignment already contains `role`, `perspective`, `assignedFiles`, `requiredCoverage`, and `group`, which is enough to suppress reviewer rows in the deep reviewer phase. The `AgentSwarm` tool call id is stable today as `review:deep-agent-swarm`, but the TUI should avoid hard-coding that value if it can rely on the stored id from the `review.started` event.

**Test plan for this issue:** Extend `apps/kimi-code/test/tui/controllers/session-event-handler-review.test.ts` with a Deep Review scenario that sends `review.started` with an `agentSwarm` payload, then sends several `review.assignment.started` events for reviewer assignments. Assert that `state.transcriptContainer.addChild()` received the `AgentSwarmProgressComponent`, that `handler.hasActiveAgentSwarmToolCall()` is true, and that appended review transcript entries do not contain repeated `Reviewer started` rows. Add a second controller test that sends a reconciliator assignment after the deep reviewer phase and verifies that reconciliation can still surface as a compact progress row. Add a message-flow test in `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` that renders a Deep Review transcript and checks the visible order: start summary, Deep Review/AgentSwarm block, no long assignment-start list below it. Keep the existing generic AgentSwarm tests intact, including the test that proves later transcript entries can exist after a normal AgentSwarm tool call. This change is review-specific, so it should not weaken ordinary AgentSwarm behavior. Manual verification should run `/review`, select `Deep Review`, and confirm the live terminal remains centered on the AgentSwarm grid while reviewer agents start, run, suspend, complete, or fail.

### Issue 5: Multi-agent reviews must show perspectives before launch

**Issue:** Multi-agent review modes need to show the generated review perspectives before any reviewer agents start. The current command only asks what to review, previews the diff, asks for intensity, then starts review. For `Thorough`, it writes a notice with the focused reviewer names, but that notice is not interactive and it appears after the user has already selected the intensity. For `Deep Review`, the notice is even weaker: it says the review will split files across overlapping focused reviewers, but it does not show the actual perspectives, file grouping, reviewer count, or reconciliation shape. The user asked for the generated perspectives to be listed, and this matters because multi-agent review spends more time and tokens than `Standard`. The user should have one last chance to inspect the plan and cancel before the run starts.

**What the code does today:** `handleReviewCommand()` gathers the optional focus text, prompts for scope, resolves the target, calls `previewReviewTarget()`, writes `Reviewing N files: +A -D.`, and then prompts for intensity. If the selected intensity is `thorough`, it calls `showNotice('Thorough review', ...)` with a constant named `THOROUGH_REVIEW_PERSPECTIVE_LABELS`. If the selected intensity is `deep`, it calls `showNotice('Deep review', ...)` with generic wording. Neither path mounts a dialog or selector. Neither path can be cancelled after the perspectives are shown. The command then calls `startReview()` immediately.

**Root cause:** The TUI does not have a review-plan preview. It has a diff preview and a start-review RPC, but nothing in between. The SDK exposes `listReviewBaseRefs()`, `listReviewCommits()`, `previewReviewTarget()`, `startReview()`, and `cancelReview()`. The core session API mirrors those methods. The deeper orchestration code knows the real plan only inside `ReviewOrchestrator`: `Thorough` uses `THOROUGH_REVIEW_PERSPECTIVES`, and `Deep Review` builds a `DeepCoverageMatrix` from the changed files. That matrix has the details the UI needs: perspective names, file groups, reviewer assignments, coverage count, and reconciliation groups. But `apps/kimi-code` cannot import `@moonshot-ai/agent-core` directly, so the TUI currently keeps its own Thorough label constant and has no clean way to derive the Deep matrix before launch. That duplication is already drifting from the intended design. It also creates a testing blind spot: command tests only assert that a Thorough notice includes one perspective and that a Deep notice says "overlapping focused reviewers". They do not assert a confirmation step, they do not assert exact perspective lists, and they do not assert cancellation before `startReview()`.

**What I will do:** Add an explicit review-plan preview boundary before the run starts. The best shape is a small core model such as `ReviewPlanPreview`, returned by a new `previewReviewPlan()` RPC or included as an optional field on the existing target preview when intensity is known. Because intensity is chosen after target preview today, a separate method is cleaner: the command can call it after `promptReviewIntensity()` and before `startReview()`. The input should include the resolved target, selected intensity, optional focus, and already-known diff stats if the RPC layer supports reusing them. The output should be structured enough for the TUI to render without duplicating orchestration rules:

```ts
interface ReviewPlanPreview {
  readonly intensity: ReviewIntensity;
  readonly reviewerCount: number;
  readonly perspectives: readonly string[];
  readonly fileGroups?: readonly {
    readonly label: string;
    readonly files: readonly string[];
    readonly perspectives: readonly string[];
  }[];
  readonly reconciliationGroups?: readonly string[];
}
```

The exact shape can be refined, but the important point is ownership: core creates the plan, SDK carries it, and TUI displays it. `Thorough` should show three reviewer agents and their perspectives. `Deep Review` should show four perspectives today, the number of reviewer assignments, and a short note that every changed file receives overlapping coverage. It does not need to list every file in a huge diff; a compact group summary is better. For example: `28 file groups x 4 perspectives = 112 reviewer assignments` is more useful than dumping every path. If the user provided a focus, the confirmation should include a short `Focus:` line so the user sees exactly what the reviewers will be biased toward.

**UI behavior:** Replace the current passive notices with a confirmation dialog. The dialog should be mounted through the same editor-replacement path as other slash-command selectors. It should have a title such as `Review perspectives`, a compact body, and two choices: `Start review` and `Cancel`. `Esc` should cancel. Cancelling here must not call `startReview()`, and it should restore the editor. If the transient preview-line fix has landed, this cancellation path should also clear the temporary `Reviewing N files` row. The dialog can follow the `StartPermissionPromptComponent` pattern because that component already supports explanatory lines plus selectable actions. A dedicated component is still likely better than overloading `ChoicePickerComponent`, because the content is a structured review plan rather than a list of equivalent choices.

**Interaction with later UI:** The perspective confirmation should not replace active review progress. It is a pre-launch gate. Once the user confirms, `startReview()` should emit the normal review events and the active display should take over. The plan shown at confirmation should match the active display summary later. If `Thorough` says three reviewer agents before launch, the active progress should also say three reviewer agents. If `Deep Review` says a certain reviewer assignment count before launch, the `AgentSwarm` component should receive the same item count. This gives users a stable mental model: inspect the plan, start it, watch that same plan run.

**Test plan for this issue:** Add core tests for the review-plan preview so `Thorough` and `Deep Review` return the same perspectives and counts as the orchestrator will use. Add SDK/RPC tests that prove the TUI can request the plan without starting review. Add command tests for `Thorough` and `Deep Review`: after selecting intensity, the command should mount the perspective confirmation, show the expected labels, and only call `startReview()` after the user confirms. Add cancellation tests at the confirmation step to verify no reviewer agents start. Add a regression test that `Standard` skips the perspective confirmation because it has only one reviewer and does not need a multi-agent plan gate. Manual verification should run `/review`, select `Thorough`, confirm the three perspectives are visible, cancel, and verify no review starts; then repeat with `Deep Review` and confirm the displayed reviewer count matches the `AgentSwarm` grid after launch.

### Issue 6: `/review` must be described as code review, not Git changes

**Issue:** The `/review` command is currently described as `Review Git changes`. That wording is too narrow and it points the user's attention at the transport mechanism instead of the task. The command does not ask the user to inspect Git history for its own sake. It starts a code-review workflow over a selected local change set, optionally guided by focus text, and returns actionable review findings. The current wording also undersells the important parts of the feature: the review is read-only, the user chooses what to review, and reviewer agents perform the inspection. For a user seeing `/review` in autocomplete or `/help`, `Review Git changes` can sound like a generic diff viewer or a Git utility command. That is not the product behavior we are designing.

**What the code does today:** The bad text originates in the built-in slash-command registry, where the `review` command has `description: 'Review Git changes'`. `KimiTUI.getSlashCommands()` filters that registry by experimental flags and passes the resulting command objects to two user-visible surfaces. `setupAutocomplete()` maps `cmd.description` into `SlashAutocompleteCommand`, so the phrase appears while the user types slash commands. `showHelpPanel()` passes the same commands into `HelpPanelComponent`, which renders the command descriptions in the `/help` panel. Command parsing and resolution do not use the text; they only care that `/review` is registered, idle-only, and gated by the `code_review` experimental flag. The actual command behavior in `handleReviewCommand()` is broader than the current description: it accepts optional focus text, prompts for a review scope, resolves working-tree, branch, or single-commit targets, previews file and line counts, asks for intensity, then starts the review workflow. The scope labels in `review-options.ts` also show that Git is only how the command identifies a change set. It is not the user goal.

**Where the copy has drifted:** The same narrow wording is duplicated in documentation. The English slash-command reference says `/review [<focus>]` will `Review Git changes` and later says it starts a read-only workflow `for Git changes`. The Chinese reference mirrors that framing with `Git 变更`. The configuration docs describe the `code_review` flag as enabling the built-in `/review` workflow `for Git changes`. The core experimental flag description is better because it says `Enable the built-in /review workflow and review worker runtime`, but it is less user-facing and does not repair the TUI wording. I also checked the ACP path. ACP has its own small built-in command registry and `/review` is not currently listed there, so this particular bad description is not rendered by ACP help today. If ACP later exposes review as a built-in command, it should not invent separate wording; otherwise the same drift will come back through another client surface.

**What I will do:** Replace the slash-command registry description with a short human-facing sentence: `Review selected code changes with read-only reviewer agents.` This is short enough for autocomplete and `/help`, but it says what the command actually does. It avoids the phrase `Git changes` because Git is a selection mechanism, not the feature's purpose. Keep the longer product explanation in docs: `Review code changes in this repository. Choose what to review, add an optional focus, then Kimi runs read-only reviewer agents and returns actionable findings.` That longer text should appear in the code-review reference section and can guide any future help copy that has room for more than one sentence. The docs table should use a compact version: `Review selected code changes; optional focus text tells reviewers what to emphasize. Requires the code_review experimental feature.` The configuration flag description should say it enables the built-in review workflow for selected code changes, not for Git changes. The Chinese docs should be updated in the same change so the product meaning remains aligned across languages.

**Implementation notes:** This does not require changing command semantics. `/review [<focus>]` remains the command shape, the experimental flag remains `code_review`, and the command remains idle-only. I would not centralize all slash-command copy into a global module just for one sentence. The registry is already the right source for TUI slash-command descriptions, and the existing command list keeps copy next to command metadata. The important part is to make the registry wording precise and then add tests that protect it. If a later implementation adds ACP review support, that should either reuse the same description constant or include a small test that proves the ACP command list uses the same human-facing phrase. The optional argument itself could be made clearer with an `argumentHint` such as `[focus]` if the underlying slash-command type supports it consistently, because `FileMentionProvider` already knows how to render argument hints. That is a useful polish item, but the core fix is the description.

**Test plan for this issue:** Add or extend the built-in command registry test so it asserts that the `review` command description is exactly `Review selected code changes with read-only reviewer agents.` and does not contain `Git changes`. Keep the existing assertions that `/review` is experimental and idle-only. Add a focused autocomplete test using `FileMentionProvider` to prove the new description is what users see when typing `/rev` after the `code_review` flag has made the command visible. Add a help-panel test with a `review` command fixture so the rendered `/help` text includes the new description. Finally, add a documentation check or at least run `rg "Review Git changes|for Git changes|Git 变更|用于 Git 变更"` after the edit to prove the old framing is gone from the command registry and review docs. Manual verification should enable the review experiment, type `/rev`, confirm autocomplete shows the new wording, open `/help`, and confirm `/review` is presented as code review of selected changes rather than as a Git command.

### Issue 7: The scope selector needs an "Ahead of upstream" option

**Issue:** The first `/review` selector is missing the option that most closely matches a normal pull-request review: review every commit on the current branch that has not been pushed to, or is not contained in, the configured upstream branch. Today the user must choose `Current branch`, open a second selector, and manually pick a base branch, tag, or commit. That is slower, less discoverable, and more error-prone than a dedicated `Ahead of upstream` choice. It also makes the review feel unlike the common mental model of "review what my branch contributes on top of its upstream." The desired behavior is clear: the first selector should include `Ahead of upstream`, and choosing it should start a review of the current branch's ahead changes without a secondary base-ref selector.

**What the code does today:** The TUI scope model is hard-coded to three values: `working_tree`, `current_branch`, and `single_commit`. `REVIEW_SCOPE_CHOICES` only contains those three labels, and `isReviewScopeChoice()` rejects anything else. `handleReviewCommand()` calls `promptReviewScope()`, then `resolveReviewTargetFromScope()`. The working-tree path returns a working-tree review target immediately. The current-branch path calls `session.listReviewBaseRefs()`, opens a searchable `Review against` selector, and returns a `current_branch` target with the selected `baseRef`. The single-commit path calls `session.listReviewCommits()`, opens a commit selector, and returns a `single_commit` target. There is no branch-status or upstream-status lookup in this flow. The command therefore cannot render or resolve an upstream shortcut.

**What the lower layers can already represent:** Core review targets also have only three scopes, but `current_branch` is already enough to review a branch against its upstream once the upstream ref is known. `resolveReviewTarget()` resolves `baseRef` and `headRef` to full commit SHAs, and branch previews use `git diff base...head`, which is the right shape for a PR-style branch review. The orchestrator always previews the target first and then starts review using the resolved target, so a UI shortcut can become a normal resolved `current_branch` target before any reviewer sees it. The review tools also switch on `working_tree`, `current_branch`, and `single_commit` when reading patches or file versions. Preserving the existing `current_branch` target at runtime avoids a broad new switch case across `ReadPatch`, `ReadFileVersion`, review background, coverage, and reconciler flows.

**Root cause:** There is no review-owned upstream metadata API. `listReviewBaseRefs()` lists local branches, tags, and recent commits for the manual base selector, but it does not identify the current branch's configured upstream, whether that upstream exists, or how many commits the branch is ahead. The TUI footer has a separate Git status cache that parses ahead and behind counts from `git status --porcelain -b`, but that code only exposes counts and the current branch name; it does not expose the upstream branch ref that review needs as a base. It also lives in the app layer, while review target resolution already lives in core through `Kaos`. I checked this worktree as a concrete failure case: `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` fails because `feat/code-review` has no upstream configured. The selector must account for that state instead of offering a dead action.

**What I will do:** Add a core helper for review upstream metadata, exposed through `Session`, core RPC, and the node SDK. The shape can be small: return `ReviewUpstreamInfo | null`, where the object includes the upstream ref name, upstream commit SHA, head commit SHA, ahead count, and behind count. Core should compute it with guarded Git commands: resolve `@{upstream}` to a human-readable ref name, resolve `@{upstream}^{commit}` and `HEAD^{commit}`, and use `git rev-list --left-right --count @{upstream}...HEAD` to calculate ahead and behind. The helper should return `null` when the directory is not a Git repository, no upstream is configured, or the upstream ref cannot be resolved. It should throw only for genuinely unexpected Git execution failures that should be surfaced consistently with the existing review target errors.

In the TUI, build review scope choices dynamically instead of using the static `REVIEW_SCOPE_CHOICES` array directly. The new choice should appear between `Current branch` and `Single commit`, matching the desired product order. If upstream metadata is available and the branch is ahead, render `Ahead of upstream` with a description such as `Review all commits ahead of origin/main · 5 commits ahead.` Choosing it should return `{ scope: 'current_branch', baseRef: upstream.upstreamRef }`, then the existing preview path resolves it to full SHAs. If there is no upstream or zero ahead commits, the least surprising first pass is to omit the option from the selectable list and rely on Issue 8's richer selector context to make unavailable states explicit later. If we decide users must always see the option, `ChoicePickerComponent` needs disabled-option support; it does not have that today, so making the option selectable only to show an error would be noisier than omitting it.

**Test plan for this issue:** Add core Git-target tests that create a branch with an upstream, add commits ahead of that upstream, and assert that the new upstream helper returns the upstream name plus the correct ahead count. Add tests for no-upstream and no-repository cases. Add SDK forwarding tests for the new method, mirroring the existing `listReviewBaseRefs()`, `previewReviewTarget()`, and `startReview()` tests. Add TUI review-command tests that mock upstream metadata, select `Ahead of upstream`, and verify the command calls `previewReviewTarget()` with a `current_branch` target using the upstream ref without opening the secondary `Review against` selector. Update the existing single-commit test because the new option changes selector order. Add a no-upstream command test to prove the option is absent or unavailable and that the other review scopes still work. Manual verification should cover a branch with no upstream, a branch with upstream but zero ahead commits, and a branch with upstream plus at least one ahead commit; only the last case should let the user start an ahead-of-upstream review.

### Issue 8: The scope selector needs real context, not generic descriptions

**Issue:** The `What to review` selector should help the user decide before they start opening secondary selectors or previewing a diff. Today each option has generic copy. `Working tree` says it reviews uncommitted tracked and untracked changes, but it does not say whether there are staged changes, unstaged changes, untracked files, or no uncommitted work at all. `Current branch` says it reviews `HEAD` against a selected branch, tag, or commit, but it does not show the current commit hash or subject. After Issue 7, `Ahead of upstream` also needs concrete upstream context such as `origin/main · 5 commits ahead`. Without this information, the selector is asking users to make a choice while hiding the facts they use to choose.

**What the code does today:** The scope selector is built from the static `REVIEW_SCOPE_CHOICES` array in `review-options.ts`. `promptReviewScope()` passes that array directly into `promptChoice()`, and `ChoicePickerComponent` renders each option label and description exactly as supplied. There is no asynchronous metadata step before the first selector. The first time `/review` asks the session for repository facts is after the user has already selected a scope: `current_branch` calls `listReviewBaseRefs()`, `single_commit` calls `listReviewCommits()`, and every scope later calls `previewReviewTarget()`. That preview does return changed file counts and line counts, but it happens too late for the first selector. It also computes the full diff, which is heavier than what we need just to annotate choices.

**What existing helpers can and cannot provide:** The TUI footer has a Git status cache that reads the current branch, dirty state, ahead/behind counts, and uncommitted line stats. That might look tempting, but it is not the right source for review scope context. It is synchronous, app-local, cached for footer rendering, and optimized around display badges. It does not distinguish staged from unstaged files, does not count untracked files separately, and does not expose the `HEAD` subject. More importantly, `apps/kimi-code` should consume review capabilities through `@moonshot-ai/kimi-code-sdk`, not reimplement review Git logic locally. The protocol REST filesystem Git status shape is also too coarse: it tracks file statuses such as `modified` and `untracked`, but not staged versus unstaged counts and not the current commit subject. The core review Git helper is the right layer because it already owns Git command execution through `Kaos`, target resolution, commit listing, and review-safe error handling.

**What I will do:** Add a lightweight review selector metadata API in core and expose it through Session, RPC, and the node SDK. The shape should be purpose-built for the first selector, for example `ReviewScopeSummary`, not a full diff preview. It should include a working-tree summary with `stagedCount`, `unstagedCount`, and `untrackedCount`; a current `HEAD` summary with full SHA, short SHA, and subject; and the upstream summary from Issue 7 when available. Core can compute the working-tree counts from `git status --porcelain=v1 -z --untracked-files=all`: count entries with an index status as staged, entries with a worktree status as unstaged, and `??` entries as untracked. Conflicted entries should be counted as unstaged and surfaced in a separate `conflictedCount` only if the implementation wants to warn clearly; they should not silently disappear. Core can compute `HEAD` with `git log -1 --format=%H%x09%h%x09%s`. The command should treat failures to fetch this metadata as non-fatal and fall back to static descriptions, because a helper failure should not prevent the user from reaching the existing review flow.

**UI behavior:** Build review scope choices dynamically before mounting the first selector. `Working tree` should produce compact descriptions such as `2 staged · 4 unstaged · 1 untracked`, or `No uncommitted changes detected` when all counts are zero. `Current branch` should include the short hash and subject, for example `HEAD 3980a55 · feat: run deep review through AgentSwarm`, followed by the existing explanation that the user will choose a base next. `Ahead of upstream` should use the upstream metadata from Issue 7, for example `origin/main · 5 commits ahead`, and should follow Issue 7's availability rule. `Single commit` can remain mostly static in the first selector because the actual commit picker already shows recent commits with short hash and subject; if metadata is cheap, it can say `Choose from the 50 most recent commits`, matching `listReviewCommits()`.

**Implementation notes:** Keep formatting helpers in `review-options.ts`, but keep Git collection in core. Do not make `ChoicePickerComponent` know about review-specific context; it should continue to render labels and descriptions. Do not reuse the footer `GitStatusCache` for review. It has a different freshness model and would couple the slash command to a visual footer concern. The command host mock in `review.test.ts` will need the new session method. If the metadata call is added before the scope prompt, cancellation still behaves normally: the user has not selected a target yet, and no preview line should be mounted.

**Test plan for this issue:** Add core tests that create staged, unstaged, untracked, and clean working-tree states and assert the new metadata helper returns the right counts. Add a core test for `HEAD` metadata and a detached-HEAD case if Git returns an empty branch name. Add SDK forwarding tests for the new metadata method. Add TUI review-command tests that render the first picker and assert `Working tree` includes staged, unstaged, and untracked counts, while `Current branch` includes a short hash and subject. Add a fallback test where the metadata call rejects and the command still renders the selector with static descriptions. Add a narrow `review-options.ts` utility test for pluralization and compact description formatting, so UI copy remains stable without snapshotting the whole selector. Manual verification should run `/review` in a clean repo, with only untracked files, with staged and unstaged changes, and on a branch whose `HEAD` subject is long enough to verify wrapping and truncation remain professional.

### Issue 9: User-facing intensity name must be `Deep Review`

**Issue:** The third review intensity should be named `Deep Review` everywhere a user can see the mode name. The current UI still exposes `Deep` in the review-intensity selector and `Deep review` in notices, progress labels, documentation, and test fixtures. This is more than a capitalization nit. `Standard` and `Thorough` read naturally as intensity names, but `Deep` alone is vague and easy to confuse with model names, internal constants, or generic "deep" wording. The desired product term is clearer: `Deep Review` tells the user that this is a specific review mode, and it lines up with the earlier design that describes this option as the AgentSwarm-backed review path for risky or large changes.

**What the code does today:** The TUI selector data defines the `deep` option with label `Deep` and description `Swarm-backed review for risky or large changes.` After the user selects it, the command shows a notice titled `Deep review`. Core then emits the Deep reviewer phase as an AgentSwarm tool call whose description is `Deep review reviewers`. The same wording appears again in core-generated subagent descriptions such as `Deep review: Files 1-4 / Correctness and regressions`, reconciliator descriptions such as `Reconcile Deep review: Security and data safety`, and a few failure messages that can surface when the AgentSwarm-capable launcher is unavailable or a worker result is malformed. The English and Chinese slash-command docs also list the option as `Deep`. Existing tests assert several of these strings, so a future implementation has to update the fixtures and expectations deliberately rather than only changing the selector.

**Boundary:** The internal value must remain `deep`. `ReviewIntensity` is exported from agent core and re-exported by the node SDK, and `review.started` events expose `intensity: 'standard' | 'thorough' | 'deep'`. That machine-readable value is a protocol and SDK contract. Renaming it to `deep_review` would create unnecessary migration work across SDK consumers, RPC tests, protocol events, stored review state, and every switch that branches on review intensity. The fix is a display-name cleanup, not a type rename. Internal function names such as deep reviewer orchestration, coverage matrix construction, and constants with `DEEP_REVIEW` in their identifier names can stay as they are. Model-facing prompt text can also be treated separately; if the phrase appears only inside the worker instruction and not in user output, it is less urgent than selector, transcript, AgentSwarm, and docs copy.

**What I will do:** Add a small display-name helper in the TUI review options module, for example a function that maps `standard` to `Standard`, `thorough` to `Thorough`, and `deep` to `Deep Review`. Use it wherever the command or selector needs an intensity label, starting with the review-intensity choices and the post-selection notice. Keep the helper local to the app layer because `apps/kimi-code` must consume review behavior through the SDK and must not import agent-core internals. In core, add a local display constant such as `DEEP_REVIEW_DISPLAY_NAME = 'Deep Review'` for strings that originate from the orchestrator. Use that constant to build `Deep Review reviewer phase` or `Deep Review reviewers` for the AgentSwarm description, `Deep Review: Files 1-4 / Correctness and regressions` for queued reviewer task descriptions, and `Reconcile Deep Review: Security and data safety` for reconciliator task descriptions. If an error message can reach the user, use `Deep Review` there too. Do not centralize this in a shared package unless a real cross-package display API emerges; duplicating one display constant on each side of the SDK boundary is less risky than coupling the TUI to core implementation details.

**Interaction with the next issue:** This report only covers the textual rename. The animated `Deep Review` label in the selector is a separate issue because it affects rendering, theme timing, and selector invalidation. The naming work should land first, so the animation can target the final label and avoid animating a string that will immediately change. The implementation should still make the selector data capable of carrying `Deep Review` as plain text, and the animation layer should be an optional presentation detail rather than the only place the label is assembled.

**Test plan for this issue:** Update the review-command tests so the intensity selector contains `Deep Review`, selecting it still sends `intensity: 'deep'` to `startReview()`, and the notice title is `Deep Review`. Add or update a focused utility test for the intensity display helper if one is introduced. Update the session-event-handler review test fixture for the AgentSwarm description and assert that the AgentSwarm component receives the `Deep Review` wording. In agent-core deep-review tests, assert that queued reviewer task descriptions and reconciliator descriptions use `Deep Review` while every machine-readable input still uses the internal `deep` value. Update the coverage-matrix error expectation if the surfaced error copy changes. Update the English and Chinese slash-command docs so the third intensity is documented as `Deep Review`. As a guard, run a targeted search for `label: 'Deep'`, `**Deep**`, and `Deep review` in the review TUI, review core, tests, and reference docs. Any remaining match should be intentionally internal, model-facing, or part of a lowercase sentence where it is not naming the product mode.

### Issue 10: `Deep Review` should animate in the intensity selector

**Issue:** The `Deep Review` option in the review-intensity selector should draw attention with a subtle wave animation across the characters. The user specifically asked for each character to color-shift like a wave. This is a visual affordance for the most expensive and most distinctive review mode, not a new review behavior. It should appear while the `Review intensity` selector is open, stay readable in dark and light themes, respect the current theme palette, and stop as soon as the selector closes through selection, cancellation, or replacement by another panel.

**What the code does today:** `ChoicePickerComponent` renders every option label as static text. The only label variations are selected versus unselected state and the optional danger tone. `ChoiceOption` carries `value`, `label`, `tone`, and `description`; it has no way to mark one label as animated or to provide a label renderer. The review command maps `ReviewChoice` into `ChoiceOption` through `toChoiceOption()` and mounts a plain `ChoicePickerComponent` for all review selectors. The picker also does not receive a `TUI` instance or a `requestRender` callback, so it has no animation clock. Existing animated components, such as live thinking, compaction, `AgentSwarm` progress, the activity loader, and the dance controller, each own a timer or controller and ask the UI to repaint. The selector has none of that lifecycle today.

**Root cause:** The current picker was designed as a static generic list. That is a reasonable default, but it means the `Deep Review` animation cannot be implemented by changing only the review option label. A pre-colored string in `REVIEW_INTENSITY_CHOICES` would not animate, would embed stale ANSI codes if the theme changes, and would make search text include escape sequences unless carefully separated from the searchable label. A review-specific subclass would work, but it would duplicate the shared selector behavior and drift from the design spec. The right fix is a small generic opt-in in `ChoicePickerComponent`, so `/review` can request animation for one option while every other selector remains static.

**Lifecycle risk:** The editor replacement path currently clears the editor container and restores the editor, but it does not dispose the previous replacement component. That is harmless for static pickers, but it becomes a leak if the picker owns an interval. There is already a `hasDispose()` helper used by streaming components. The implementation should extend the editor-replacement lifecycle to dispose any mounted replacement that implements `dispose()`, both when mounting a new replacement and when restoring the editor. The review command should not rely on callers remembering to stop a timer manually. Timer cleanup must be part of the component and host lifecycle.

**What I will do:** Extend `ChoiceOption` with a narrowly named optional field such as `labelAnimation?: 'wave'`. Extend `ChoicePickerOptions` with an optional `requestRender?: () => void`. When the picker contains at least one visible option with `labelAnimation: 'wave'` and a render callback is available, start a small interval that increments a phase and requests a render. Add `dispose()` to `ChoicePickerComponent` to clear the interval. The label renderer should keep `label` as the plain searchable and semantic text, then apply color only at render time. For the wave itself, add a focused helper near the theme text helpers, probably beside `gradientText`, that takes the plain text, current phase, and theme hex values. It should color visible characters one by one, skip spaces so word spacing is stable, and bold the label only when the selected style would already be bold. Use existing theme colors such as `primary`, `accent`, and possibly `success`; do not use chalk named colors or hard-coded one-off hues. The helper should read `currentTheme.palette` during render so theme switches recolor the next frame.

In `/review`, mark only the `deep` intensity option as animated after Issue 9 has renamed its display label to `Deep Review`. The scope selector, base-ref selector, commit selector, and other app selectors should not animate. If `requestRender` is not passed, the option should fall back to a static theme-colored label so unit tests and non-interactive render paths remain deterministic. Use the same truncation path the picker already uses; ANSI styling must not change the visible width or cause the label to overflow narrow terminals.

**Test plan for this issue:** Add `ChoicePickerComponent` tests with fake timers. One test should render an option with `labelAnimation: 'wave'`, advance the timer, assert that `requestRender()` was called, and assert that the ANSI color sequence for `Deep Review` changes between frames while the stripped text remains `Deep Review`. Another test should call `dispose()`, advance timers again, and assert no further render requests occur. Add a host lifecycle test around `KimiTUI.mountEditorReplacement()` and `restoreEditor()` using a disposable fake replacement to prove replacement disposal works. Add a review-command test that opens the intensity selector and verifies the `deep` option carries the wave animation flag while selecting it still starts review with `intensity: 'deep'`. Add a theme-focused test for the wave helper that renders with dark and light palettes and confirms it uses theme hex values rather than named colors. Manual verification should run `/review`, reach `Review intensity`, watch `Deep Review` animate, press `Esc`, and confirm the animation stops and no repeated render requests continue after the editor is restored.

### Issue 11: `ReadFileVersion` labels should show short refs

**Issue:** `ReadFileVersion` activity labels are too noisy when the tool reads from a resolved commit ref. The visible label can become `Used file version: AGENTS.md (ref 3980a555807687914079243f9476fef93cbfd081 · from line 1)`, which is much harder to scan than `Used file version: AGENTS.md (ref 3980a55 · from line 1)`. This appears inside the main transcript header and inside subagent activity summaries, which makes multi-agent review output feel heavier than it needs to be. The user is not asking to change what the tool reads or what evidence it returns. The request is only about the user-facing label.

**What the code does today:** Core `ReadFileVersionTool` builds generic display metadata with summary `file version: <path>` and detail assembled from the selected source plus the line range. When the caller passes `ref`, the source detail is `ref ${args.ref}`, so a full resolved commit SHA is embedded in display metadata. The execute result also returns `ref: result.ref`, which is correct because it is machine-readable evidence of the exact file version that was read. In the TUI, `formatReviewToolLabel()` handles `ReadFileVersion` specially. It reconstructs the label from tool arguments whenever path, version, ref, line offset, or line count are present. In `readFileVersionDetail()`, the same full-ref string is produced from the args before falling back to display metadata. `ToolCallComponent` uses that formatter for both the main tool header and nested subagent activity, so one formatter decision affects `Using file version...`, `Used file version...`, and the compact activity line shown under a running reviewer agent. Successful review tool results intentionally render no raw JSON body, so the label is the primary visible signal.

**Root cause:** The formatter treats a Git ref as ordinary display text. That is safe, but it ignores the fact that resolved review targets often replace branch names or commit choices with full commit SHAs before workers run. The review command already has some short-hash behavior in nearby UI, such as commit choices showing `commit.sha.slice(0, 12)`, while the plan's desired label uses 7 characters. Git itself also supplies short object names in some review base-ref descriptions. There is no single shared helper that clearly owns all Git ref display in the TUI, so the review tool formatter needs a small local rule rather than a broad refactor. The rule must be careful: shorten SHA-like refs, not arbitrary refs. A branch named `feature/3980a555807687914079243f9476fef93cbfd081` is odd but still a branch name, and a tag or symbolic ref like `HEAD`, `HEAD^`, `origin/main`, or `v1.2.3` should remain readable as written.

**What I will do:** Add a small helper for review tool display, such as `formatReviewRefForLabel(ref: string): string`. It should return a short prefix only when the input looks like a full Git object id, for example a 40-character SHA-1 hex string or, if the repo ever uses SHA-256 object ids, a 64-character hex string. For those values, use the short length chosen for this UI. Because the existing plan example says 7 characters when no shared helper exists, the first implementation should use 7 unless the team decides to align with the 12-character commit picker. The important part is consistency inside `ReadFileVersion` labels. For anything that does not match a full object id, return the original ref unchanged.

Apply that helper in `apps/kimi-code/src/tui/components/messages/tool-renderers/review.ts` inside `readFileVersionDetail()`, so labels derived from live args, streaming fallback args, and nested subagent activity all shorten the same way. Also update `packages/agent-core/src/tools/builtin/review/read-file-version.ts` or the shared review display helper so generic display metadata uses the same short label. This second change matters for approval descriptions and for any future UI that trusts display metadata directly instead of reconstructing from args. Do not change `ReadFileVersionInputSchema`, tool args, coverage recording, `readFileVersionForTarget()`, or the JSON result. The model and review runtime should still receive and store the full ref.

**Test plan for this issue:** Add direct tests for the TUI formatter with a full SHA ref, asserting that `formatReviewToolLabel('ReadFileVersion', ...)` returns `file version: AGENTS.md` plus detail `ref 3980a55 · from line 1`. Add sibling cases for `version: 'base'`, a short ref, `HEAD`, `HEAD^`, `origin/main`, and a tag to prove only full object ids are shortened. Extend `ToolCallComponent` tests so both a main `ReadFileVersion` tool call and a nested reviewer sub-tool activity show the short ref and never show the long ref. Add an agent-core review-tool display test for `ReadFileVersionTool.resolveExecution()` with a long `ref`, confirming generic display metadata is also shortened while the execute result still includes the full `ref`. Keep the existing tests that successful review tools render no JSON body. Manual verification should run a review that reads a file at a resolved commit SHA and confirm the transcript shows the short ref while any expanded or copied tool result still contains the exact full ref in structured output.

### Issue 12: `Thorough` review should show the parallel reviewer count

**Issue:** `Thorough` review really does run multiple focused reviewers, but the active UI does not make that shape obvious. The user sees `Review started`, three separate `Reviewer started` rows, and then foreground reviewer-agent activity such as `Reviewer Agent Running (Review changes: Correctness and regressions)`. That output explains individual events, but it does not answer the user's practical questions: how many reviewer agents are expected, whether they are running in parallel, whether more agents will start later, and when the run moves from reviewer work to reconciliation. On a large change set, one reviewer card can collect hundreds of tool events and a large token count, so the transcript looks like a single runaway reviewer instead of one member of a deliberate three-reviewer phase.

**What the code does today:** Core orchestration is clear. The `thorough` branch creates one reviewer assignment for each `THOROUGH_REVIEW_PERSPECTIVES` entry: `Correctness and regressions`, `Security and data safety`, and `Maintainability and tests`. Each reviewer receives all changed files, patch coverage, role `reviewer`, and group `thorough`. The orchestrator then starts those reviewer workers through `Promise.all()`, so the intended execution model is parallel. Only after the reviewer promises settle does it create one `reconciliator` assignment, also in group `thorough`, with the candidate source comments attached. The runtime emits `review.assignment.started` once for each assignment, and the session forwards those events to the SDK event stream. The event payload has enough per-assignment facts to identify role, group, perspective, assigned-file count, and required coverage, but it does not contain a phase-level summary such as "three reviewer agents are now running".

**Why the UI becomes confusing:** `SessionEventHandler` treats every assignment start as a standalone notice. It appends a `ReviewProgressComponent` titled `Reviewer started` for all assignments, regardless of whether the assignment is a reviewer or a reconciliator. It also labels terminal progress as `Reviewer complete` or `Reviewer blocked`, again without checking the role. Separately, review workers are foreground subagents with parent tool call id `review`. `SubAgentEventHandler` first tries to attach foreground subagent lifecycle events to an `AgentSwarm` progress component or an existing parent tool-call component. `Thorough` has neither. When the parent component is missing, the handler can create or update standalone subagent tool-call UI, which is why the user sees long `Reviewer Agent Running` blocks in addition to the review assignment notices. The generic `AgentGroupComponent` does not solve this automatically because it groups normal `Agent` tool calls from the same streaming step, while review workers are launched by the review orchestrator under a synthetic parent id. The pre-launch notice in `/review` does list the Thorough perspectives, but it is a separate transcript entry before the active run. It is not a live phase display, and it does not stay connected to subagent progress.

**Root cause:** The review UI currently renders assignment events and subagent lifecycle events as independent facts. It does not maintain an aggregate "Thorough reviewer phase" state. The core already knows this is a three-reviewer phase, and the TUI can infer the same thing from assignment `group`, `role`, and `perspective`, but no component owns that aggregation. This is different from `Deep Review`: that mode gets an explicit `agentSwarm` payload on `review.started`, so the TUI can mount `AgentSwarmProgressComponent` as the primary active surface. `Thorough` needs a smaller review-owned group, not the `AgentSwarm` UI and not the generic agent grouping behavior.

**What I will do:** Add a compact active-review phase display for `Thorough`. When a `review.started` event arrives with intensity `thorough`, the TUI should create state for a `Thorough review` panel. As `review.assignment.started` events arrive with group `thorough` and role `reviewer`, the panel should register the perspectives and suppress the separate `Reviewer started` rows. Because core creates the three reviewer assignments before launching workers, the TUI should know the full reviewer set almost immediately. The panel should render copy like `3 reviewer agents running in parallel`, followed by `Perspectives: Correctness and regressions, Security and data safety, Maintainability and tests` and the diff stats. If a review-plan payload is added as part of the perspective-confirmation work, this panel should use that payload for the expected reviewer count before assignment events arrive. If that payload is not available in the first implementation, deriving the set from the three assignment events is acceptable as long as the panel updates quickly and does not append three noisy rows.

The same display needs to absorb the matching foreground subagent lifecycle. For review subagents whose parent tool call id is `review` and whose active review intensity is `thorough`, `SubAgentEventHandler` should route lifecycle and latest-activity updates into the review phase panel instead of creating standalone reviewer cards. The panel does not need every nested tool detail; it should show enough status to make the run understandable: waiting, running, complete, blocked, or failed per perspective, plus an overall count. When the reviewers finish and the reconciliator assignment starts, the panel should switch to a reconciliation phase or append one compact reconciliation row, for example `Reconciliation running · 1 reconciliator`. Reconciliator progress must not be mislabeled as reviewer progress. On completion, cancellation, failure, or reset, the component should settle or dispose cleanly so the transcript remains readable.

**Test plan for this issue:** Add an agent-core test that proves `Thorough` starts all reviewer workers before waiting for any one reviewer to finish. The existing success test proves there are three reviewer assignments, but a pending-promise test would better protect the parallel contract. Add a TUI session-event test that sends `review.started` with intensity `thorough`, then three grouped reviewer assignment-start events, and verifies the visible output contains one compact `Thorough review` summary with `3 reviewer agents running in parallel` instead of three separate `Reviewer started` entries. Add a subagent-routing test that sends foreground reviewer lifecycle events with parent tool call id `review` during an active Thorough review and verifies they update the review phase display rather than creating standalone reviewer-agent cards. Add a reconciliator test that sends a grouped reconciliator assignment and checks the label changes to reconciliation. Manual verification should run `Thorough` on a large change set and confirm the first active screen clearly shows the three perspectives, the parallel reviewer count, the current phase, and the transition to reconciliation without a long list of repeated reviewer-start rows.

## Desired User Experience

### `/review` description

Use this wording as the product intent:

```text
Review code changes in this repository. Choose what to review, add an optional focus, then Kimi runs read-only reviewer agents and returns actionable findings.
```

Short slash-command description:

```text
Review selected code changes with read-only reviewer agents.
```

Avoid `Review Git Changes` as the main description. Git is the target-selection mechanism, not the user goal.

### Review scope selector

The selector should include:

```text
Working tree
Review uncommitted changes.

Current branch
Review the current branch against a branch, tag, or commit.

Ahead of upstream
Review all commits on this branch that are ahead of its upstream branch.

Single commit
Review one selected commit.
```

The actual UI should add compact status details:

- `Working tree`: show staged, unstaged, and untracked counts when available.
- `Current branch`: show `HEAD` short hash and the first line of the commit message.
- `Ahead of upstream`: show upstream branch name and ahead count, for example `origin/main · 5 commits ahead`.
- `Single commit`: show recent commits with short hash, subject, and relative age if the selector already has that data.

### Review intensity selector

Use these labels:

```text
Standard      Single reviewer for everyday changes.
Thorough      Multiple focused reviewers before opening a PR.
Deep Review   Uses AgentSwarm for risky or large changes.
```

`Deep Review` should animate in the selector. Each character should color-shift over time like a small wave. The animation should stay readable, respect the current theme palette, and stop when the selector closes.

### Perspective confirmation

Before launching `Thorough` or `Deep Review`, show the generated perspectives.

Minimum behavior:

```text
Review perspectives

Correctness and regressions
Security and data safety
Maintainability and tests
```

The user can confirm or cancel. Editing can remain out of scope for this pass.

### Active review display

The active review UI should answer these questions immediately:

- What is being reviewed?
- Which intensity is running?
- How many reviewer agents are running?
- Which perspectives are active?
- Is this in the reviewer phase or reconciliation phase?

For `Thorough`, show one compact group instead of one noisy line per reviewer:

```text
Reviewing changes...

Thorough review
3 reviewer agents running in parallel
Perspectives: Correctness and regressions, Security and data safety, Maintainability and tests
112 files: +9071 -39
```

For `Deep Review`, the `AgentSwarm` progress component should be the primary display during the reviewer phase. Do not bury it below repeated `Reviewer started` entries. Suppress or collapse per-assignment review progress while the `AgentSwarm` UI is active.

Expected `Deep Review` shape:

```text
Deep Review
AgentSwarm reviewer phase
N reviewer agents · each changed file covered by at least 2 reviewers
112 files: +9071 -39

[AgentSwarm progress grid]
```

When reconciliation starts, replace or follow the `AgentSwarm` section with a compact reconciliation section. Do not keep appending a long live list that pushes the useful UI out of view.

### Cancellation

Cancellation has two separate states:

- Selector stage: cancelling should remove transient preview text such as `Reviewing N files: +A -D`.
- Active review stage: cancelling should ask for confirmation, stop active agents, end review mode, and return to the original chat state.

No partial review should be shown as a complete result after cancellation.

### Model and provider errors

Provider errors during review should not crash the program.

Expected behavior:

```text
Review stopped
The reviewer model returned a rate-limit error. You can retry the review or continue chatting.
```

The app should:

- catch errors from reviewer, reconciliator, and `AgentSwarm` child runs
- mark review mode inactive
- stop or detach active review UI state
- preserve the main chat session
- show a concise error message
- avoid treating partial comments as a complete review

### Tool labels

`ReadFileVersion` labels should show short hashes:

```text
Used file version: AGENTS.md (ref 3980a55 · from line 1)
```

not:

```text
Used file version: AGENTS.md (ref 3980a555807687914079243f9476fef93cbfd081 · from line 1)
```

Use the same short-hash length used elsewhere in the repository, or 7 characters if there is no shared helper.

## Likely File Map

- `apps/kimi-code/src/tui/commands/review.ts`: review command flow, selector order, cancellation cleanup.
- `apps/kimi-code/src/tui/utils/review-options.ts`: review option labels, descriptions, stats text, scope display helpers.
- `apps/kimi-code/src/tui/components/dialogs/*`: selector spacing and animated option rendering, depending on where `ChoicePickerComponent` lives.
- `apps/kimi-code/src/tui/controllers/session-event-handler.ts`: review progress events, review cancellation/failure handling, `AgentSwarm` UI coordination.
- `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts`: avoid competing subagent cards while `AgentSwarm` progress owns the Deep Review reviewer phase.
- `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts`: confirm it can act as the primary Deep Review reviewer display.
- `apps/kimi-code/src/tui/components/messages/review-progress.ts`: compact active review summary, if this component exists.
- `apps/kimi-code/src/tui/components/messages/tool-renderers/review.ts`: `ReadFileVersion` short-hash label.
- `packages/agent-core/src/review/git-target.ts`: target resolver for "ahead of upstream".
- `packages/agent-core/src/review/orchestrator.ts`: perspective generation events and graceful error status.
- `packages/agent-core/src/rpc/events.ts` and `packages/protocol/src/events.ts`: event payloads for perspectives, review phases, and `AgentSwarm` summary data if needed.
- `packages/node-sdk/src/types.ts` and `packages/node-sdk/src/events.ts`: public SDK event/type mirrors.
- `docs/en/reference/slash-commands.md` and `docs/zh/reference/slash-commands.md`: user-facing `/review` explanation.

## Implementation Phases

### Phase 1: Fix cancellation and model-error safety

- [ ] Add a TUI test that starts `/review`, reaches the diff preview, cancels before review starts, and verifies the preview line is removed.
- [ ] Add a TUI or controller test that simulates a review failure event and verifies `reviewActive` becomes false and the editor/chat state remains usable.
- [ ] Add an agent-core test where a reviewer returns a provider-style error and `startReview()` returns or throws through the review failure path without leaving active runtime state behind.
- [ ] Implement selector-stage cleanup for transient review preview entries.
- [ ] Catch review worker, reconciliator, and `AgentSwarm` reviewer errors at the review boundary and emit `review.failed` instead of letting the process crash.
- [ ] Verify cancellation during active review still asks for confirmation.

### Phase 2: Improve scope selection

- [ ] Add a failing test for the new `Ahead of upstream` scope.
- [ ] Resolve the upstream branch for the current branch and compute commits ahead of it.
- [ ] Add selector metadata for working tree counts, current branch short hash and subject, upstream name, and ahead count.
- [ ] Update the scope selector copy.
- [ ] Verify detached HEAD, missing upstream, and no-ahead-commits cases have clear messages.

### Phase 3: Show perspectives before multi-agent review

- [ ] Add a TUI test for `Thorough`: after intensity selection, perspectives are displayed before reviewer agents start.
- [ ] Add a TUI test for `Deep Review`: perspectives are displayed before `AgentSwarm` starts.
- [ ] Add a confirm/cancel step for the perspectives screen.
- [ ] Keep editing perspectives out of scope.

### Phase 4: Redesign active review progress

- [ ] Add a TUI test that `Thorough` shows a compact summary with the number of parallel reviewer agents.
- [ ] Add a TUI test that `Deep Review` shows `AgentSwarm` progress as the primary display and does not append one visible `Reviewer started` row per assignment.
- [ ] Collapse or suppress assignment-start entries while an aggregate multi-agent progress panel is active.
- [ ] Show phase labels: reviewer phase, reconciliation phase, complete, blocked, failed, cancelled.
- [ ] Keep the transcript readable after the review completes.

### Phase 5: Polish selectors

- [ ] Update `ChoicePickerComponent` or the review-specific selector wrapper to support blank lines between options.
- [ ] Add an opt-in spacing mode if the global selector should not change everywhere.
- [ ] Add the `Deep Review` animated label in the intensity selector.
- [ ] Use theme tokens for the animation.
- [ ] Ensure the animation stops cleanly after selection, cancellation, or unmount.

### Phase 6: Fix labels and docs

- [ ] Shorten `ReadFileVersion` hashes in tool labels.
- [ ] Replace `/review` descriptions with the human-facing wording in this plan.
- [ ] Update English and Chinese docs together.
- [ ] Add or update a changeset for the user-visible fixes.

## Verification Checklist

- [ ] `pnpm --filter @moonshot-ai/agent-core exec vitest run test/review`
- [ ] `pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/review.test.ts`
- [ ] `pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/controllers/session-event-handler-review.test.ts`
- [ ] `pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages/agent-swarm-progress.test.ts`
- [ ] `pnpm --filter @moonshot-ai/kimi-code run typecheck`
- [ ] `pnpm --filter @moonshot-ai/agent-core run typecheck`
- [ ] `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`
- [ ] Manual smoke test: cancel during selector stage and confirm no preview line remains.
- [ ] Manual smoke test: force a reviewer model error and confirm the app returns to chat.
- [ ] Manual smoke test: run `Thorough` and confirm the UI shows reviewer count and perspectives.
- [ ] Manual smoke test: run `Deep Review` and confirm the `AgentSwarm` UI remains visible while running.
