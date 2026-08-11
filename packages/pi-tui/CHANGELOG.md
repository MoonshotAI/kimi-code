# @moonshot-ai/pi-tui

## 0.80.8

### Patch Changes

- [#1976](https://github.com/MoonshotAI/kimi-code/pull/1976) [`e458323`](https://github.com/MoonshotAI/kimi-code/commit/e45832398d0d9cad98dbad1cbf1e5b103a20aace) Thanks [@liruifengv](https://github.com/liruifengv)! - Speed up the terminal renderer in long sessions by reusing processed lines across frames.

## 0.80.7

### Patch Changes

- [#1408](https://github.com/MoonshotAI/kimi-code/pull/1408) [`fc259ab`](https://github.com/MoonshotAI/kimi-code/commit/fc259abdb415fe9ac10132a142bdb5ce507ccda2) Thanks [@liruifengv](https://github.com/liruifengv)! - Support searching multiple workspace roots for `@` file completion through fd, deduplicated by absolute path.

## 0.80.6

### Patch Changes

- [#1367](https://github.com/MoonshotAI/kimi-code/pull/1367) [`23daf0f`](https://github.com/MoonshotAI/kimi-code/commit/23daf0f3c199b4aaa9bd9388a2903d7827f98d32) - Revert the fork's viewport and scrollback rendering patches, restoring the upstream differential-rendering behavior. The narrow-terminal fixes (width clamping, overwide-line truncation) are kept.

## 0.80.5

### Patch Changes

- [#1305](https://github.com/MoonshotAI/kimi-code/pull/1305) [`9091627`](https://github.com/MoonshotAI/kimi-code/commit/909162725770700efd3051f4cfa68156d9b84fa8) - Add a paste-burst fallback that treats Enter as a newline during rapid non-bracketed multi-line input bursts.

- [#1353](https://github.com/MoonshotAI/kimi-code/pull/1353) [`68ad686`](https://github.com/MoonshotAI/kimi-code/commit/68ad686211760eb1c3e6b5c23eb28ace9009c17f) - Pin the viewport anchor on partial shrinks and repaint above-viewport shifts in place, so streaming shrink/grow cycles no longer stack duplicate copies of content in scrollback; only a collapse past the viewport top re-anchors the view.

## 0.80.4

### Patch Changes

- [#1315](https://github.com/MoonshotAI/kimi-code/pull/1315) [`b40bb71`](https://github.com/MoonshotAI/kimi-code/commit/b40bb7139939eb2ba734ce5dd4871b894d7033e8) - Re-anchor the viewport with an in-place repaint whenever content shrinks below the screen bottom, and clamp deleted-line clearing to the screen bottom, so large shrinks no longer blank the screen, desync the cursor, or leave the UI hovering above dead rows.

- [#1295](https://github.com/MoonshotAI/kimi-code/pull/1295) [`77eb3a9`](https://github.com/MoonshotAI/kimi-code/commit/77eb3a9fe40c93fa32e335f07160b8128355bab6) - Add history hooks to the editor so hosts can filter entries (`setHistoryFilter`), decorate recalled entries (`onRecall`), and save and restore their own state alongside the history draft (`onHistoryDraftSave` / `onHistoryDraftRestore`).

- [#1303](https://github.com/MoonshotAI/kimi-code/pull/1303) [`2639786`](https://github.com/MoonshotAI/kimi-code/commit/2639786ce578f15c020a2c11c344797dae18de61) - Fix crashes on very narrow terminals: word-wrapping wide graphemes no longer recurses infinitely at one-column width, render width is clamped to a minimum of one column, and overwide rendered lines are truncated instead of throwing.

## 0.80.3

### Patch Changes

- [#1254](https://github.com/MoonshotAI/kimi-code/pull/1254) [`7859b0a`](https://github.com/MoonshotAI/kimi-code/commit/7859b0afe8898852806e5a0c21b9dd52cb82f834) - Export the package manifest so the bundled binary can locate its native assets.

- [#1254](https://github.com/MoonshotAI/kimi-code/pull/1254) [`7859b0a`](https://github.com/MoonshotAI/kimi-code/commit/7859b0afe8898852806e5a0c21b9dd52cb82f834) - Integrate the fork into the monorepo and load it directly from source.

- [#1254](https://github.com/MoonshotAI/kimi-code/pull/1254) [`7859b0a`](https://github.com/MoonshotAI/kimi-code/commit/7859b0afe8898852806e5a0c21b9dd52cb82f834) - Clamp the differential render to the visible viewport so scrolling up during streaming no longer jumps to the top.
