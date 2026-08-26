# Bug Fix: Model chooser needs memorable single-key favorite (A/R) like the provider list

- **Slug**: model-chooser-favorites-keys
- **Fixed**: 2026-08-26
- **Assessment**: ./assessment.md
- **Status**: applied
- **Branch**: fix/model-chooser-favorites-keys
- **Revision**: uncommitted (changes staged in working tree, not yet committed)

## Summary

Replaced the undiscoverable `Alt+M` (favorite) and `Alt+S` (session-only) key
bindings in the `/model` chooser with a consistent, memorable `Shift`+letter scheme:
`Shift+A` adds the highlighted model to Favorites, `Shift+R` removes it, and
`Shift+S` applies the choice to the current session only. The editor `Alt+M`
favorite rotation is intentionally left untouched — it is a separate feature.
Bindings are intercepted before the search list consumes the character, so
type-to-search (lowercase `a`/`r`/`s`) still works.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `apps/kimi-code/src/tui/components/dialogs/model-selector.ts` | modified | Intercept `Shift+A`/`Shift+R`/`Shift+S` before `this.list.handleKey`; removed `Alt+M`/`Alt+S` branches; updated hint line and `onToggleFavorite`/`onSessionOnlySelect` doc comments. |
| `apps/kimi-code/src/tui/components/dialogs/tabbed-model-selector.ts` | modified | Updated `FAVORITES_EMPTY_MESSAGE` and the `onToggleFavorite`/`onSessionOnlySelect` doc comments to the new keys. |
| `apps/kimi-code/src/tui/commands/config.ts` | modified | Updated the `/model` "press Alt+M to add" notice to `Shift+A`. The `tui.toml` `favorite_models` comment (which describes the *editor* `Alt+M` rotation) was left unchanged on purpose. |
| `apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts` | modified | Reworked `Alt+M`/`Alt+S` tests to `Shift+A`/`Shift+R`/`Shift+S`; added no-op cases for already-favorited/unfavorited models. |
| `apps/kimi-code/test/tui/components/dialogs/tabbed-model-selector.test.ts` | modified | Updated empty-state hint assertion and the forward test; added a `Shift+R` forward test. |

## Diff Highlights (optional)

`ModelSelectorComponent.handleInput` now gates favorites/session keys up front:

```ts
const ch = printableChar(data);
if (ch === 'A' || ch === 'R') {
  const selected = this.selectedChoice();
  if (selected !== undefined && this.opts.onToggleFavorite !== undefined) {
    const isFavorite = this.opts.favoriteAliases?.has(selected.alias) ?? false;
    if ((ch === 'A') !== isFavorite) this.opts.onToggleFavorite(selected.alias);
  }
  return;
}
if (ch === 'S' && this.opts.onSessionOnlySelect !== undefined) {
  const selected = this.selectedChoice();
  if (selected === undefined) return;
  this.opts.onSessionOnlySelect({ alias: selected.alias, thinking: commitEffort(selected, this.effectiveEffort(selected)) });
  return;
}
```

`A` adds only when not already a favorite; `R` removes only when it is — so the
same `onToggleFavorite` callback covers both directions without a host change.

## Tests Added or Updated

- `model-selector.test.ts::ModelSelectorComponent favorites` — `Shift+A adds … when not already a favorite`, `Shift+A is a no-op when already a favorite`, `Shift+R removes …`, `Shift+R is a no-op when not a favorite`, hint mentions `Shift+A favorite · Shift+R unfavorite`.
- `model-selector.test.ts` session-only block — `Shift+S` invokes `onSessionOnlySelect`; hint shows `Shift+S session-only`.
- `tabbed-model-selector.test.ts::TabbedModelSelectorComponent favorites` — empty-state hint shows `Shift+A`; `Shift+A` forwards a non-favorite; `Shift+R` forwards a favorite.

## Local Verification

- Commands run: `pnpm exec vitest run test/tui/components/dialogs/model-selector.test.ts test/tui/components/dialogs/tabbed-model-selector.test.ts test/tui/printable-key-guard.test.ts` → **53 passed**. `printable-key-guard` (which forbids bare-literal key comparisons in `handleInput`) passes, confirming the new code routes through `printableChar`.
- Full `test/tui` suite: running in background at time of writing; targeted + guard suites green.
- Manual checks: confirmed lowercase `a`/`r`/`s` still reach the search filter (the shortcuts only fire on the uppercase Shift variants), and `config.ts`'s editor-rotation `Alt+M` strings were not altered.

## Deviations from Assessment

- The assessment listed `config.ts:253-254` (the `tui.toml` `favorite_models` comment) as a string to update. On inspection those lines describe the **editor** `Alt+M` rotation (a separate, intentionally-kept feature), not the `/model` dialog binding. They were left unchanged to avoid documenting the wrong feature. Only `config.ts:1135` (the dialog-add notice) was updated, as it references the dialog's favorite action.
- `effort-selector.ts` and `choice-picker.ts` still bind `Alt+S` for their own session-only selects. Those are different pickers outside this bug's scope (the report is about the model chooser); left unchanged to keep the change minimal. Noted as a follow-up for consistency.

## Follow-ups

- Consider aligning `effort-selector.ts` / `choice-picker.ts` session-only bindings to `Shift+S` for consistency across pickers.
- Update any user docs / tips that still mention `Alt+M` for favoriting in `/model` (e.g. `apps/kimi-code/src/tui/commands/config.ts` notice already updated; check docs/zh and docs/en release notes if they reference the old binding).
