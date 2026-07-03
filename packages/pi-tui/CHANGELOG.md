# @moonshot-ai/pi-tui

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
