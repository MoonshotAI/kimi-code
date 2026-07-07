# pi-tui Agent Guide

`packages/pi-tui` is a vendored copy of pi-tui from the upstream pi-mono project (baseline: upstream 0.80.2, see commit `7859b0af`). It is no longer patched via pnpm patches — all local fixes are applied directly to the source. The differential-rendering behavior in `src/tui.ts` matches upstream: the fork's viewport/scrollback rendering patches were reverted; the only remaining divergences are listed below.

## Local divergences from upstream (must be preserved on every re-vendor)

Never overwrite this directory wholesale when syncing from upstream. Each of the following local fixes must be re-verified after a sync; all of them are guarded by tests:

1. **`src/components/editor.ts` — `wordWrapLine` single-grapheme recursion guard**: when a segment cannot be split further (a single grapheme) and is wider than `maxWidth`, do not recurse (upstream recurses infinitely and overflows the stack at maxWidth=1 with CJK). The guard must be based on grapheme count (`graphemeSegmenter.segment(...)`), not code-unit length — `grapheme.length` misjudges ZWJ emoji. Guarding tests: "wordWrapLine narrow width" and "Editor narrow width rendering" in `test/editor.test.ts`.
2. **`src/tui.ts` — `Container.render` width clamp**: `width = Math.max(1, width)` at the entry point. Guarding test: "Container width clamping" in `test/tui-render.test.ts`.
3. **`src/tui.ts` — truncate overwide lines instead of throwing**: `doRender` truncates overwide lines with `sliceByColumn` before `applyLineResets`; the upstream "write crash log + throw" block in the differential render path has been removed — do not bring it back when syncing. Performance constraint: the truncation check scans every line every frame, so it must go through the `asciiVisibleWidth` fast path in `utils.ts` first (ANSI-aware ASCII scan with an early exit past the limit) and only fall back to `visibleWidth` for non-ASCII lines; `WIDTH_CACHE_SIZE` is 4096 to match. Known boundary: with more than 4096 distinct non-ASCII lines the width cache FIFO thrashes (~30ms/frame); the real fix is a prepared-frame per-row cache, tracked as follow-up work. Guarding tests: "TUI overwide line handling" in `test/tui-render.test.ts` (exact viewport assertions) and "asciiVisibleWidth" in `test/truncate-to-width.test.ts`.
4. **`src/components/text.ts` / `markdown.ts` / `truncated-text.ts` / `editor.ts` — negative-width `repeat` guards**: the `repeat` counts for blank lines, horizontal rules, and the editor's top/bottom borders are clamped to ≥ 0 (two editor border sites; markdown's emptyLine and hr — the hr site is currently unreachable from the render entry and is purely defensive). Guarding tests: the "negative width safety" cases — Text's lives in `test/tui-render.test.ts` (Text has no dedicated test file), Markdown's and TruncatedText's live in their own test files; the editor's is "does not throw at zero or negative widths" inside the "Editor narrow width rendering" group in `test/editor.test.ts`.

## Acceptance after syncing from upstream

- `pnpm --filter @moonshot-ai/pi-tui test` must pass in full; any failure among the guarding tests above means a local divergence was overwritten and lost.

## Testing

- This package's tests run with `node --test` (`pnpm --filter @moonshot-ai/pi-tui test`), not vitest; the root `vitest run` does not execute them — CI covers them through the dedicated `test-pi-tui` job in `.github/workflows/ci.yml`.
- Prefer adding new narrow-width tests to the existing test file of the corresponding component.
