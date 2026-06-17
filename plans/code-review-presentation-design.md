# Code Review Presentation Design

## Goal

The review pipeline produces structured findings, but today they are flattened
into one markdown transcript message (`formatReviewResultMarkdown`) and then
lost on compaction. That is a wall of text that most users will not read.

This design defines how review findings are **persisted, presented, browsed,
and acted on** after a review completes. It does not change how reviews are
produced — only what happens to `ReviewResult` once the orchestrator returns.

## Design principle: one artifact, three verbs

Findings are not three "presentation modes" the user picks up front. They are
one durable artifact with three verbs layered over it, in escalating order of
engagement:

- **Fix** — the user acts without reading ("fix these for me").
- **Triage** — the user skims findings interactively and rejects bad ones.
- **Export / discuss** — the user takes the findings elsewhere or argues them
  with the agent.

The user often does these in sequence (skim a few, reject one, fix the rest,
export what's left). So nothing gates on a choice. The review produces one
artifact; the verbs hang off it.

## Sources of truth

Two stores, with a strict division of authority:

- **JSON file (per review, on disk)** — SSOT for *full content*: comment
  bodies, evidence, suggested fixes, diff anchors. Also the artifact the **agent
  reads** when asked to fix findings. Comment state is updated here on reject so
  the agent sees rejections.
- **Transcript records** — SSOT for *compact display state*. The compact block
  renders from the transcript alone, so it survives a missing or moved session
  folder and replays deterministically.

The only mutation after a review completes is **reject**. Reject always writes
both: it emits a transcript record *and* updates the JSON. Because reject is the
sole mutation and always does both, the two stores cannot meaningfully diverge.

## Persistence

### Location and naming

Reviews are written under the session folder, one file per review:

```text
<sessionDir>/reviews/<timestamp>.json
```

- `<timestamp>` (e.g. `20260614-143052`) names the file so reviews sort
  naturally and never collide within a session.
- A user may run multiple reviews per session; each gets its own file.

### User-facing id

The timestamp is the on-disk name, not what the user types. Each review is
assigned a **short ordinal** (`1`, `2`, `3`, …) within the session. `/review
read 2` and autocomplete use the ordinal; the ordinal maps to the timestamped
file via an index.

### Artifact schema

Reuses existing types where they exist (`ReviewTarget`, `ReviewDiffStats`,
`ReviewIntensity`, `ReviewCommentSeverity`, `ReviewCommentState`,
`ReviewDismissalReason`). The one new reason value is `rejected_by_user`.

```ts
/** The on-disk artifact: <sessionDir>/reviews/<timestamp>.json */
type ReviewArtifact = {
  /** Short ordinal, session-scoped (the id the user types). */
  readonly id: number;
  /** ISO timestamp; also the basis for the on-disk filename. */
  readonly createdAt: string;
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
  readonly stats: ReviewDiffStats;
  readonly summary: string;
  /** Full comment records — bodies live here, never in a transcript record. */
  readonly comments: readonly {
    readonly id: string;
    readonly severity: ReviewCommentSeverity;
    readonly title: string;
    readonly body: string;
    readonly evidence?: string;
    readonly suggestedFix?: string;
    /**
     * Where the comment lives in the diff — NOT a working-tree line. The
     * reviewer worked from the diff, so the comment is pinned to a (side,
     * line) pair in that diff, which keeps the browser correct regardless of
     * how the working tree changes after the review. See "Diff view".
     */
    readonly anchor: {
      readonly path: string;
      readonly side: 'old' | 'new';
      /** Line number in that side's coordinate space. */
      readonly line: number;
      /** Hunk the line belongs to, e.g. "@@ -38,6 +38,9 @@". */
      readonly hunkHeader: string;
    };
    /** 'candidate' | 'merged' | 'dismissed'. */
    readonly state: ReviewCommentState;
    /** Set when rejected; null while still active. */
    readonly dismissal: {
      readonly reason: ReviewDismissalReason; // includes new 'rejected_by_user'
      readonly note?: string;                 // optional one-line user note
    } | null;
  }[];
};
```

## Transcript records

### `review.completed`

Emitted when a review finishes. Embeds **compact metadata only** — never
comment bodies — plus the pointers needed to open the full artifact:

```ts
type ReviewCompletedRecord = {
  readonly kind: 'review.completed';
  readonly reviewId: number;
  /** Absolute path to the full JSON artifact. */
  readonly jsonPath: string;
  readonly summary: string;
  /** Compact per-comment metadata — enough to render the compact block alone. */
  readonly comments: readonly {
    readonly id: string;
    readonly severity: ReviewCommentSeverity;
    readonly title: string;
    readonly path: string;
    readonly line: number;
  }[];
};
```

This is rendered as the **compact block** (below). Because the metadata is
embedded, the compact list renders even if the JSON file is absent.

### `review.comment_rejected`

Emitted each time the user rejects a comment in the browser:

```ts
type ReviewCommentRejectedRecord = {
  readonly kind: 'review.comment_rejected';
  readonly reviewId: number;
  readonly commentId: string;
  /** Optional one-line user note. */
  readonly note?: string;
};
```

## Compact block (default render)

After a review completes, the compact block is **always** rendered — never the
full text. It is a custom transcript record whose rendered view is not its raw
content, and it updates in place (precedent: `updateToolCall`, and the forced
historical re-render in `kimi-tui.ts`).

Layout:

```text
Code review · 12 files · +420 -96 · 5 comments (1 critical · 1 rejected)

  ! critical  src/auth.ts:88   Token refresh races on concurrent logins
  ! important src/api.ts:142   Missing null check before deref
  · minor     src/util.ts:7    Redundant clone
  (rejected)  src/foo.ts:42    Off-by-one in slice bound

  /review read 2
```

- Grouped/sorted by severity; rejected comments shown struck/dimmed at the end.
- The persistent footer is just the reopen command (`/review read 2`) — this is
  what stays in scrollback and on replay.
- When there are no comments, the block is the plain "No issues found" line with
  no footer and no selector — no friction on the fix-it path.

### Post-review selector

A bare keypress affordance (`press r`) cannot work here: the compact block is
passive scrollback and the editor has focus, so `r` would just type `r`. The
codebase has no bare-printable global shortcut for this reason — browsers like
`TasksBrowserApp` open from a slash command, and the only key shortcuts are
modifier chords or empty-buffer arrows.

So immediately after the compact block renders (and only when there are
comments), we show a **`ChoicePicker`** to dispatch the next action. A picker is
a focused modal (container-replacement, takes focus), so keystrokes go to it,
not the editor — no ambiguity. It also doubles as the entry point for the three
verbs.

```text
┌ Review 2 complete · 5 comments (1 critical) ────────────────────────┐
│                                                                     │
│ Choose what to do next.                                             │
│                                                                     │
│ ▸ Browse comments     Read each comment next to its code, one at a  │
│                       time. You can open this any time with /review │
│                       read 2.                                       │
│                                                                     │
│   Export to Markdown  Save all the comments to a Markdown file. You │
│                       can also do this any time with /review export │
│                       2.                                            │
│                                                                     │
│   Back to chat        Go back to the conversation to talk about the │
│                       comments or ask the agent to fix them.        │
│                                                                     │
│ ↑/↓ select · enter confirm · esc dismiss                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Each description is plain and complete, and names the command that does the
same thing — so the picker is a convenience, never the only way in. Use the
picker's `optionSpacing: 'relaxed'` for the blank lines between choices.

- `Browse comments` → opens the interactive reader (same as `/review read 2`).
- `Export to Markdown` → writes the Markdown file (same as `/review export 2`).
- `Back to chat` / `Esc` → returns to the conversation, where the user can
  discuss the comments or ask the agent to fix them. The compact block stays in
  scrollback and is reopenable any time with `/review read 2`.

The selector is a one-time live interaction. It is **not** re-shown on
replay/resume — only the compact block re-renders (from records). Re-entry is
always via `/review read [id]`.

### Render = fold(records)

The block's rendered state is a pure function of transcript records:

```text
render(reviewId) = fold( review.comment_rejected* over review.completed )
```

On replay/resume the renderer folds every `review.comment_rejected` for the
review id over the `review.completed` record and shows the **modified** compact
list. This needs no disk access, so it is deterministic and survives a
moved/missing session folder.

## Interactive browser

Opened from the post-review selector (`Browse comments`) or `/review read
[id]`. Full-screen alt-screen takeover via **container swap**, modeled directly on
`TasksBrowserApp` (saves the main TUI children, mounts as sole child, restores
on exit). Props-in / callbacks-out; the controller owns state.

### `/review read` resolution

- `/review read` with **no id** → left pane lists *reviews* in the session;
  selecting one drills into its comments.
- `/review read <id>` → jumps straight into that review's comment list.
- `<id>` autocompletes to the session's review ordinals, with a rich label:
  `2 · 14:30 · 5 comments (1 rejected) · working tree`.
- Switching to a different review = exit and reopen (v1 — no in-browser review
  switching once inside a review).

### Layout

Two columns under a header, over a status bar:

```text
┌─ Review 2 · working tree · 5 comments (1 rejected) ────────────────────────┐
│ Comments                  │ src/auth.ts  ·  @@ -84,7 +84,12 @@             │
│───────────────────────────│────────────────────────────────────────────────│
│▸ ! crit  auth.ts:88       │   84   async function refresh(token) {         │
│  Token refresh races on   │   85 -   const next = await rotate(token)      │
│  concurrent logins        │   86 +   const next = await rotate(token, {    │
│                           │   87 +     idempotencyKey: token.id,           │
│  ! imp   api.ts:142       │┌──────────────────────────────────────────────┐│
│  Missing null check       ││ ! critical  Token refresh races …            ││
│                           ││ Two concurrent logins both call rotate…      ││
│  · min   util.ts:7        │└──────────────────────────────────────────────┘│
│  Redundant clone          │   88 +   })                                    │
│                           │   89     return next                           │
│  ⌫ rej   foo.ts:42        │   90   }                                       │
│  Off-by-one in slice      │                                                │
├───────────────────────────┴────────────────────────────────────────────────┤
│ ↑/↓ move · x reject · u un-reject · [/] next/prev file · t layout · q quit │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Left — review comments.** The comments of the selected review. Shows
  severity, title, and key metadata (`path:line`). Rejected comments are dimmed.
  This is a *comment* list (the selected review is fixed for the session).
- **Right — diff view.** The diff for the selected comment's file, scrolled to
  the comment's anchor, with the comment rendered inline as a band at that line.
- **Status bar** shows shortcuts: navigate (↑/↓), reject (`x`), un-reject (`u`),
  next/prev file (`[`/`]`), toggle diff layout (`t`), quit (`q`/Esc).

### Diff view

The right pane is a **diff**, not a plain file — this is what pins comments
correctly. It is **responsive**: a wide terminal shows side-by-side, a narrow
one collapses to unified/inline, with the comment band spanning the full width
in both.

```text
 Side-by-side (wide)                      Unified / inline (narrow)
┌────────────────────┬─────────────────┐  ┌──────────────────────────────┐
│ 85   rotate(token) │ 86   rotate(t,{ │  │ 85 - rotate(token)           │
│                    │ 87     idemKey…)│  │ 86 + rotate(token, {         │
│┌───────────────────┴────────────────┐│  │ 87 +   idempotencyKey: …,    │
││ ! critical  Token refresh races…   ││  │┌────────────────────────────┐│
││ Two concurrent logins both call    ││  ││ ! critical  Token races…   ││
│└───────────────────┬────────────────┘│  │└────────────────────────────┘│
│ 88     return next │ 88     })       │  │ 88 +   })                    │
│                    │ 89     return   │  │ 89   return next             │
└────────────────────┴─────────────────┘  └──────────────────────────────┘
```

- The comment `anchor` (`side` + `line`) points into the diff, so the band lands
  on the exact line the reviewer commented on, independent of later working-tree
  edits.
- **Responsive:** wide terminal → side-by-side; narrow → unified/inline. Width
  threshold in the component; `t` toggles manually.
- **Syntax highlighting** via `cli-highlight` (already a dependency), layered
  with diff coloring: strip the +/- gutter marker, syntax-highlight the code
  content, then apply the add/del background on top.
- **Comment band:** full-width band at the anchor line (GitHub-style); spans
  both columns in side-by-side.
- If the file changed since the review, show a "changed since review" indicator
  rather than drifting — the diff itself is from the stored review, so the band
  stays correct.

### Reject

- Reject uses the inline `y`-style confirm prompt from `TasksBrowserApp`.
- On confirm: emit `review.comment_rejected`, update the JSON comment to
  `state: dismissed`, `dismissal: { reason: "rejected_by_user", note? }`.
- v1 keeps it light: one reason + optional one-line note.

### On exit

When the user exits the browser, the controller restores the main TUI children
and the compact block re-renders from its (now folded) records — rejected
comments appear struck/dimmed and the rejected tally updates.

## Fix path

The reference to the review stays in the conversation (the `review.completed`
record names the review id and JSON path), so the user can say "fix these" or
"fix the critical ones." Contract:

- The agent's fix action **reads the JSON file**, not the transcript snapshot,
  so it sees current state.
- Rejected comments are `state: dismissed` in the JSON, so "fix the rest"
  naturally excludes them.

## Export

`/review export [id]` renders the JSON to a human-readable markdown file (the
grouped-by-severity format) for handling in an editor or sharing. Since the JSON
already lives on disk, export is a thin rendering step; if omitted, the agent
can simply report the JSON path.

## Replay / resume summary

- **Compact block:** rendered purely from transcript records
  (`review.completed` + folded `review.comment_rejected`). No disk dependency.
- **Browser (`/review read`):** loads the JSON for full content. If the JSON is
  missing, fail gracefully ("review data not found"); the compact block still
  renders.
- **Agent fix:** reads JSON; reflects rejections.

## Non-goals for this version

- In-browser switching between reviews.
- Editing comment bodies or adding user comments in the browser.
- Posting findings to a PR.
- Per-comment threaded discussion UI (the user discusses with the agent in the
  normal conversation instead).
- SARIF / editor-native diagnostics export.
