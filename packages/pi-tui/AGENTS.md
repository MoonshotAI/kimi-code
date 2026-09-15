# pi-tui

Vendored fork of [`earendil-works/pi`](https://github.com/earendil-works/pi) `packages/tui`. Keep the fork small so upstream syncs stay cheap.

**Syncing from upstream, adding a local patch, or reviewing a pi-tui diff:** read [UPSTREAM.md](./UPSTREAM.md). The fork is the diff against the pinned upstream commit; that file records why those diffs exist.

## Changing this package

Put TUI product behavior in `apps/kimi-code/src/tui` (composition, subclassing, existing host callbacks). Change this package only when the public API cannot express the behavior.

A patch that lands here must:

1. Be a library defect (crash, wrong render) or an extension point the app cannot reach (input state machine, render hot path, tokenizer).
2. Be additive: optional argument, callback, or default-off switch. Defaults match upstream.
3. Add an intent card in `UPSTREAM.md` and a test that fails without the change.

Skip step 3 and the change is not done. Do not rewrite a rendering strategy.

## Tests

This package runs `node --test` via `pnpm --filter @moonshot-ai/pi-tui test`. The repo-root vitest run does not execute these tests.
