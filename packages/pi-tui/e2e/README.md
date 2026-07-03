# pi-tui rendering e2e cases

This folder is a **bug ledger**: one test file per rendering bug we hit in
production, driving the real `TUI` against an xterm-emulated terminal
(`test/virtual-terminal.ts`, backed by `@xterm/headless`). Each case
reproduces the original failure end to end — screen contents, scrollback,
scroll position — and stays as a permanent regression guard.

Run with:

```sh
pnpm --filter @moonshot-ai/pi-tui test:e2e   # e2e cases only
pnpm --filter @moonshot-ai/pi-tui test        # unit tests + e2e cases
```

## Background: the rendering model

`TUI.doRender()` renders differentially against a logical line buffer.
`previousViewportTop` anchors which logical line sits on the top screen row.
Terminal scrollback is **append-only**: rows enter it only by scrolling off
the top of the screen, and can never be partially rewritten or truncated.
That physical constraint drives three invariants the renderer must hold:

1. **Monotonic anchor** — `previousViewportTop` never rewinds (except on a
   collapse, where the content ends at or above the screen top). Rewinding
   repaints rows scrollback already holds; the next scroll commits them
   again, duplicating the span.
2. **Exactly-once commit** — every row that crosses the viewport top must be
   scrolled into scrollback exactly once: zero times loses the row, twice
   duplicates it.
3. **Cursor bookkeeping sync** — the internal `hardwareCursorRow` must equal
   the real terminal cursor row at all times; the differential path computes
   relative moves from it, so any desync writes rows to the wrong place.

Accepted trade-offs (by design, not bugs):

- **Stale bytes**: content that changes above the viewport is not repainted
  into scrollback; scrollback keeps the old version. This avoids `ESC[3J`,
  which yanks the scroll position on Windows Terminal (microsoft/Terminal#20370).
- **Collapse seam**: a collapse rewind re-commits up to one screen of rows;
  the content changed so drastically there that the seam is not recognizable.
- **Pinned gap**: a partial shrink keeps the anchor pinned, leaving a bounded
  blank gap below the input box that the next growth refills.

## Case index

| Case | Symptom | Root cause | Status |
| --- | --- | --- | --- |
| [case01](./case01-collapse-blank-screen.test.ts) | Screen mostly blank after a large shrink (compaction), input box gone | Clamped differential path desynced the cursor when content collapsed above the viewport | Fixed (#1315) |
| [case02](./case02-collapse-scroll-position.test.ts) | Scroll position yanked to the top while reading scrollback (Windows Terminal) | Destructive full redraw emitted `ESC[3J` | Fixed (#1315) |
| [case03](./case03-full-redraw-residue.test.ts) | Stale text above the welcome banner after `/clear`; duplicated rows after ctrl+o expand | App-level session reset / expansion toggled content wholesale without a forced full redraw | Fixed (#1315, app layer uses `requestRender(true)`) |
| [case04](./case04-oscillation-duplication.test.ts) | Transcript spans duplicated in scrollback during streaming (shrink/grow oscillation) | Shrink re-anchor rewound the viewport anchor; the next grow re-committed rows scrollback already held | Fixed (#1353) |
| [case05](./case05-growth-past-anchor-row-loss.test.ts) | Transcript rows missing from scrollback after streaming | Growth past the anchor with an above-viewport change repainted in place without scrolling, so the skipped rows never got committed (invariant 2) | Fixed (#1353, review) |
| [case06](./case06-cursor-above-pinned-window.test.ts) | Rows written to the wrong screen position after a pinned shrink | `repaintViewport()` positioned the cursor to a logical row above the painted window; `hardwareCursorRow` desynced from the real cursor (invariant 3) | Fixed (#1353, review) |

A case for a not-yet-fixed bug is marked **Open** in the table and is
expected to fail — it is the executable reproduction. Flip it to Fixed
when it turns green.

Related unit-level guards (not duplicated here): kitty images straddling the
viewport top during a collapse are covered in `test/tui-shrink.test.ts`.

## Adding a case

1. Reproduce the bug with `createHarness()` from [harness.ts](./harness.ts):
   drive frames with `frame(lines)`, then assert on `getViewport()`,
   `getScrollBuffer()`, `getScrollPosition()`, or captured writes.
2. Name the file `caseNN-short-slug.test.ts` and add a row to the table
   above: symptom as the user saw it, root cause, and which invariant broke.
3. Prefer unique per-line markers (`row-42`) so exactly-once assertions
   cannot be confused by stale bytes.
