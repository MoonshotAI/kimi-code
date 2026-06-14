# Code Review Presentation — Implementation Report

Implements [code-review-presentation-design.md](./code-review-presentation-design.md).
This report records what was built, the decisions taken at my discretion, the
deviations from the design, and test coverage.

## Summary

The review pipeline now persists each completed review as a durable JSON
artifact (the SSOT), renders a compact transcript block instead of a wall of
text, offers a post-review action selector, and provides an interactive reader
(`/review read`) with a syntax-highlighted diff view and reject/restore, plus
Markdown export (`/review export`). Findings can be discussed or fixed from chat
because the agent reads the same JSON.

Delivered in seven commits, backend-first:

1. `feat(review): persist reviews as durable JSON artifacts` — artifact types,
   unified-diff parser, diff-space anchors, patch capture, `ReviewArtifactStore`.
2. `feat(review): persist on completion and expose read/reject over RPC` —
   session persistence + `listReviews`/`readReview`/`rejectReviewComment`/
   `restoreReviewComment` across session/RPC/SDK; `review.comment.rejected` event.
3. `feat(review): render completed reviews as a compact transcript block`.
4. `feat(review): interactive reader with syntax-highlighted diff view`.
5. `feat(review): add /review read & export and a post-review selector`.
6. Plan + report (this commit).

## What maps to the design

| Design element | Status | Where |
| --- | --- | --- |
| JSON SSOT, one file per review, `<sessionDir>/reviews/` | Done | `review/artifact.ts` |
| Short ordinal ids + index | Done | `ReviewArtifactStore` |
| Diff-space anchor (`path`, `side`, `line`, `hunkHeader`) | Done | `artifact.ts` + `diff.ts` |
| Reject is the only mutation; writes JSON + emits event | Done | `session/index.ts`, `review.comment.rejected` |
| `rejected_by_user` dismissal reason | Done | `types.ts`, protocol |
| Compact block (grouped by severity, reopen hint, folded rejected) | Done | `review-options.ts` |
| Post-review selector (Browse / Export / Back to chat) | Done | `commands/review.ts` |
| `/review read [id]` opens the reader; id picker when omitted | Done | `commands/review.ts` |
| `/review export [id]` writes Markdown | Done | `commands/review.ts` |
| Interactive reader: comment list, diff view, syntax highlight, comment band, reject | Done (adapted) | `components/dialogs/review-reader.ts` |
| Fix path reads the JSON (rejections excluded) | Done | agent reads artifact via `readReview` |

## Decisions taken at my discretion

- **Patch capture.** The pipeline did not previously retain diff text, which the
  diff view needs. Added `readReviewPatch` (git-target) and stored the raw
  unified diff on the artifact as a `diff` field (an addition to the design
  schema; the design’s prose already says the JSON holds diffs). Untracked
  working-tree files are captured as synthetic added-file patches.
- **Anchor side.** Reviewers cite lines in the post-change file, so anchors use
  `side: 'new'`; `hunkHeader` is derived from the captured diff and omitted when
  the line is not found.
- **Persist only non-empty reviews.** Zero-finding reviews are not written and
  show the plain summary — no selector, no friction (matches the design’s
  no-friction-on-empty rule).
- **Id resolution as a picker.** The static slash-command registry has no
  per-argument autocomplete, so `/review read`/`export` without an id show a
  searchable picker of saved reviews. This is the design’s “autocomplete”
  delivered through the project’s existing selector idiom.
- **Export location.** `/review export` writes `review-<id>.md` to the cwd and
  reports the path.

## Deviations from the design (intentional)

- **Reader is mounted in the editor region, not a full-screen alt-screen
  takeover.** I used `mountEditorReplacement` (the ChoicePicker path) rather than
  a `TasksBrowserApp`-style container-swap controller. This avoids new
  `kimi-tui.ts` controller wiring and is far lower-risk, at the cost of not being
  a literal full-window two-column browser. The layout is therefore a single
  focused comment (severity, title, body, suggested fix, diff window) with
  up/down navigation between comments, rather than side-by-side list + diff.
- **Diff view is unified, not responsive side-by-side.** The reader renders a
  windowed unified diff with the comment band under the anchor. Responsive
  side-by-side was not built.
- **Syntax highlight + diff coloring are layered conservatively.** Code is
  highlighted via `cli-highlight`; add/del are shown through a colored gutter
  (`diffAdded`/`diffRemoved`) rather than a full add/del background behind the
  highlighted text, to avoid fragile ANSI background nesting.
- **Compact-block update on reject is an append, not an in-place historical
  mutation.** On reader exit a fresh, updated compact block (folding rejected
  state from the artifact) is appended to the transcript. The
  `review.comment.rejected` event is emitted and the artifact updated, but the
  TUI does not yet re-render the *original* historical block in place, nor
  fold rejection events during session replay. `ReviewCompletedEvent.reviewId`
  exists in the protocol but is not populated by the orchestrator (the command
  uses `ReviewResult.reviewId` instead); it is reserved for a future
  transcript-record renderer.

These deviations are the main candidates for follow-up if a literal full-screen
browser and replay-fold are wanted.

## Tests

- `agent-core/test/review/diff.test.ts` — unified-diff parsing, line numbering,
  rename/add headers, anchor lookup.
- `agent-core/test/review/artifact.test.ts` — anchor derivation, store ordinals,
  list/read, reject/restore (file + index), timestamp slug.
- `agent-core/test/session/review.test.ts` — session list/read/reject/restore
  round-trip and the `review.comment.rejected` emission.
- `node-sdk/test/session-event-types.test.ts` — exhaustiveness for the new event.
- `apps/kimi-code/test/tui/review-options.test.ts` — compact render, rejected
  fold, Markdown export.
- `apps/kimi-code/test/tui/review-diff.test.ts` — diff windowing + gutter.

All touched packages typecheck clean; the TUI printable-key guard passes for the
new component.

## Not covered (phase 1)

- Runtime/visual verification of the interactive reader (no TUI harness in this
  environment); its pure helpers (diff window, formatters) are unit-tested, the
  view layer is exercised only by typecheck and the key-guard.
- The full-screen container-swap browser, responsive side-by-side diff, and
  replay-time fold of rejection events (see deviations).

---

# Phase 2 — trial feedback

After a `/review` trial (see `code-review-presentation-issues.md`), the
following was addressed. Decisions: review handles are **topic slugs** derived
from the top finding (numeric id stays the internal/RPC key); the drawer reader
stays the default with a full-screen reader reachable by `f`.

## Correctness bugs (found by the review of my own code)

- **Unescaped Markdown in export** → `escapeMarkdown` applied to every dynamic
  value in `formatReviewArtifactMarkdown`.
- **`/review read|export` vs focus text** → `parseReviewCommand` only treats
  them as subcommands when followed by ≤1 token; multi-word stays a focus.
- **Follow-up errors mis-reported as review failures** → the post-review
  selector now runs outside the review try/catch.
- **Silent "Browse" no-op / silent export overwrite** → both now surface a
  message; export picks a non-clobbering `review-<slug>.md`.
- **Follow-up titled "complete" for blocked reviews** → uses real status.

## UX changes

- **Drawer reader**: title on its own line beneath a gray path; body and
  suggested fix rendered through pi-tui Markdown (inline code/bold like chat);
  blank line before a non-gray status bar.
- **Compact block**: now a colored `ReviewSummaryComponent` (green `● Code
  review`, red/green diffstat, bold counts, severity groups) instead of plain
  Markdown.
- **Review names**: topic slugs (`/review read auth-refresh-races`); the picker
  and footer show slugs.
- **Reconciliation/progress**: suppressed the per-finding "merged/dismissed"
  stream (the reconciliator already renders as a sub-agent element + emits a
  single summary); removed the duplicate review spinner in favor of the
  `● Reviewing...` chrome.
- **Full-screen reader**: new `ReviewReaderFullscreenApp` (container-swap),
  two-column list + detail/diff; `f` switches from the drawer.

## Tests added (phase 2)

- `agent-core/test/review/artifact.test.ts` — topic-slug derivation + de-dup.
- `apps/kimi-code/test/tui/review-command.test.ts` — `parseReviewCommand`
  subcommand/focus disambiguation + `escapeMarkdown`.
- `apps/kimi-code/test/tui/review-options.test.ts` — `buildReviewSummaryData`
  (diffstat/handle/rejected fold) + Markdown export escaping.
- `apps/kimi-code/test/tui/review-reader.test.ts` — `clampIndex`.

## Still not covered

- Visual/runtime behavior of the drawer and full-screen readers (no TUI harness
  here): the shared pure helpers are unit-tested; the rendering is verified only
  by typecheck, lint, and the printable-key guard. **Worth a manual `/review`
  pass** to confirm the colored block, Markdown body, and full-screen layout.
- Responsive side-by-side diff and replay-time fold of rejection events remain
  out of scope.
- The full-screen detail pane truncates rather than scrolls when a comment’s
  body + diff exceed the viewport.
