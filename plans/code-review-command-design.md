# Code Review Command Design

## Goal

Add a built-in `/review` command that gives users a focused, read-only code review workflow. The command should keep the simple Codex-style entry point, while letting users choose deeper review coverage when they need it.

The first version should not add separate commands for security review, PR posting, auto-fix, or cloud review. Users can express a one-off focus in the command text.

```text
/review focus on auth and permission regressions
/review focus on missing tests
/review
```

## User-facing flow

### 1. Start review

The user starts the workflow with:

```text
/review <focus>
```

`<focus>` is optional free-form text. It is passed to every reviewer as custom review guidance.

Examples:

```text
/review
/review focus on security regressions
/review focus on API compatibility and missing tests
```

### 2. Choose what to review

Show a selector titled `Select review scope`.

Options:

```text
Working tree     Review staged, unstaged, and untracked changes.
Current branch   Review HEAD against a selected branch, commit, or tag.
Single commit    Review only one selected commit.
```

Behavior:

- `Working tree` reviews local uncommitted changes. It does not need a base selector.
- `Current branch` opens a second selector for the base ref. This is the user-facing version of reviewing the current HEAD against a selected branch, commit, or tag.
- `Single commit` opens a commit selector if a commit was not already provided. The review covers only that commit's patch.

### 3. Confirm diff size

After the scope is resolved, show a compact summary:

```text
Reviewing 12 files: +420 -96
```

If the diff is large, show a warning before the intensity selector. This is most important before deep review, where reviewers may read full changed files.

### 4. Choose review intensity

Show a selector titled `Select review intensity`.

Use these option labels and descriptions:

```text
Standard   Single reviewer for everyday changes.
Thorough   Multiple focused reviewers before opening a PR.
Deep       AgentSwarm-backed review for risky or large changes.
```

Detailed behavior:

- `Standard` runs one dedicated reviewer.
- `Thorough` asks the main agent to choose several review perspectives, then spawns focused sub-agents. Each reviewer reviews the whole diff from one perspective.
- `Deep` uses the existing `AgentSwarm` mechanism. This is not shorthand for any generic multi-agent fan-out. Reviewers split the changed files and perspectives with overlap, so each changed file is reviewed more than once, and the user sees the `AgentSwarm` progress UI.

### 5. Show perspectives for multi-agent modes

For `Thorough` and `Deep`, the main agent creates the review perspectives before launching reviewers.

Show them to the user first:

```text
Review perspectives:
- Correctness and regressions
- Tests and edge cases
- Project conventions
- Security focus requested by user
```

The user can confirm or cancel. Editing the generated perspectives is not needed for the first version.

### 6. Run review

The review should be read-only.

During an active review, pressing `Esc` should not stop the review immediately. Show a confirmation prompt:

```text
Stop review?
Running reviewers will be cancelled. Partial findings may be lost.
```

For pre-review selectors, `Esc` keeps the normal cancel behavior.

## Review modes

### Standard

`Standard` launches one dedicated reviewer.

The reviewer should receive:

- the selected diff
- the user's focus text, if any
- relevant repository guidance, including `AGENTS.md`
- enough nearby code context to verify findings

The reviewer should not receive private reasoning from the current implementation turn. The review should feel like a fresh second set of eyes, not a continuation of the same assumptions.

### Thorough

`Thorough` uses multiple focused reviewers.

Flow:

1. The main agent inspects the diff summary and user focus.
2. The main agent proposes review perspectives.
3. After confirmation, it spawns sub-agents.
4. Each sub-agent reviews all changes from one perspective.
5. The main agent combines and deduplicates findings.

Expected perspectives include correctness, tests, compatibility, maintainability, project conventions, and any user-specified focus.

### Deep

`Deep` uses `AgentSwarm`-backed review.

In this design, `swarm` means the concrete `AgentSwarm` tool, runtime, cancellation behavior, and TUI progress display. A direct loop that starts many review workers is not enough for `Deep`.

Flow:

1. The main agent partitions changed files into review work items.
2. It assigns overlapping coverage so every changed file is reviewed by at least two sub-agents.
3. It launches the reviewer phase through `AgentSwarm`, with one `AgentSwarm` item per review assignment.
4. Each `AgentSwarm` sub-agent receives the review background, its assignment, and the reviewer profile.
5. Each sub-agent must read every changed file assigned to it, not only the diff hunk.
6. Sub-agents review their assigned files from a specific perspective.
7. The runtime audits read coverage, progress updates, tool use, and candidate comments after the `AgentSwarm` run finishes.
8. Reconciliator sub-agents deduplicate and validate candidate findings.
9. The main agent produces the final review.

Deep review should be opt-in. It is expected to take longer and use more tokens.

## Finding quality rules

All modes should follow the same reporting standard:

- Report only issues introduced by the selected changes, unless the change makes an existing issue worse.
- Avoid style nitpicks unless repository guidance explicitly requires them.
- Avoid findings that CI, typecheckers, formatters, or linters would catch unless there is a deeper behavior risk.
- Prefer high-confidence findings with clear evidence.
- Include file and line references.
- Explain why the issue matters.
- Suggest a fix when the fix is not obvious.
- Keep the final answer concise.

## Final output

When there are findings, group them by severity:

```text
Code review

Critical
- ...

Important
- ...

Minor
- ...
```

If there are no findings, say so plainly:

```text
No issues found. Reviewed 12 files with the Standard reviewer.
```

For multi-agent modes, include a short coverage note:

```text
Reviewed with 4 focused reviewers.
```

or:

```text
Reviewed with 18 AgentSwarm reviewers. Each changed file was covered at least twice.
```

Do not include raw sub-agent logs in the final output.

## Non-goals for the first version

- Auto-fixing review findings.
- Posting GitHub PR comments.
- Cloud-hosted review.
- Separate `/security-review` command.
- User-editable generated perspectives.
- Numeric confidence scores in the UI.
- A large Claude-style effort-level matrix.
