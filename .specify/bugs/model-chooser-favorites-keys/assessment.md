# Bug Assessment: Model chooser needs memorable single-key favorite (A/R) like the provider list

- **Slug**: model-chooser-favorites-keys
- **Created**: 2026-08-26
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: low

## Report (verbatim or summarized)

> check the TUI on see provider list there is a helper say A to to add a key and when I click A it opens to add key, our crrent model chooser should have the same, pressing A should add it to favorites. this is on model chooser, when I am on favorites tab pressing R should remove from favorites, KISS remove the weird key combinations that I cant remember.

User wants the `/model` chooser to mirror the `/provider` list's discoverable single-key UX:
- `A` adds the highlighted model to Favorites (today only `Alt+M` does this).
- `R` removes the highlighted model from Favorites (on the Favorites tab).
- Remove the "weird key combinations" they can't remember — specifically `Alt+M` (favorite toggle) and `Alt+S` (session-only select) in the model chooser.

## Symptom

In `/provider`, a single key `A` adds a key and the hint line advertises it prominently (`↑↓ navigate · D delete · A add key · S set active · P proxy · Esc cancel`). In `/model`, the equivalent actions are hidden behind `Alt+M` (favorite) and `Alt+S` (session-only), which are undiscoverable and hard to remember. The user wants parity: `A` to add to favorites, `R` to remove from favorites, and the Alt-based bindings gone.

## Reproduction

1. Run `/model` in the TUI.
2. Note the hint line: it shows `Alt+M favorite` and `Alt+S session-only`, but no `A`/`R` shortcuts.
3. Highlight a model; there is no single `A` key to favorite it (only `Alt+M`).
4. Open the Favorites tab; there is no `R` key to remove the highlighted model.

Unknown: whether the user expects plain `A`/`R` or is willing to accept `Shift+A`/`Shift+R` (see Open Questions — this matters because the chooser is searchable).

## Suspected Code Paths

- `apps/kimi-code/src/tui/components/dialogs/model-selector.ts:277-291` — `handleInput` binds `Alt+M` → `onToggleFavorite` and `Alt+S` → `onSessionOnlySelect`. These are the "weird combinations" to replace.
- `apps/kimi-code/src/tui/components/dialogs/model-selector.ts:306-313` — hint-line assembly that emits `Alt+M favorite` / `Alt+S session-only`; must be replaced with `A`/`R` (and `S`) hints.
- `apps/kimi-code/src/tui/components/dialogs/model-selector.ts:88-99` — `favoriteAliases` set is already in opts, so the component can decide add-vs-remove without a new callback shape.
- `apps/kimi-code/src/tui/components/dialogs/tabbed-model-selector.ts:49` — `FAVORITES_EMPTY_MESSAGE` still says `press Alt+M to add it`; must be updated.
- `apps/kimi-code/src/tui/components/dialogs/tabbed-model-selector.ts:132-146` — `handleInput` forwards keys to the active inner selector; no change needed unless we want `R` to be a no-op outside the Favorites tab (the inner selector already knows `favoriteAliases`, so add/remove can be gated there).
- `apps/kimi-code/src/tui/commands/config.ts:1043-1077` — `showModelPicker` wires `onToggleFavorite` → `toggleFavoriteModel` (append/remove) and `onSessionOnlySelect` → `performModelSwitch(..., false)`. The existing toggle already supports add-by-toggle-when-not-favorite and remove-by-toggle-when-favorite, so `A`/`R` can reuse it with no host-side logic change.
- `apps/kimi-code/src/tui/commands/config.ts:1135` and `config.ts:253-254` — user-facing text (`Open /model and press Alt+M…`, tui.toml comment) references `Alt+M`; update.
- `apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts:602-626` — tests assert `Alt+M` toggles favorite and the hint mentions `Alt+M`; must be reworked to the new bindings.
- `apps/kimi-code/test/tui/components/dialogs/tabbed-model-selector.test.ts` — may assert favorite/empty-message behavior referencing `Alt+M`.

## Root Cause Hypothesis

Not a crash — a UX parity / discoverability gap. The provider manager (`provider-manager.ts:115,375-412`) uses a non-searchable list, so bare single keys `A`/`D`/`S`/`P` are free and discoverable via the hint line. The model chooser (`model-selector.ts`) is **searchable** (`searchable: true` set in `tabbed-model-selector.ts:276`), so `SearchableList.handleKey` (`searchable-list.ts:141-146`) consumes every printable character — including `a`/`r` — as a filter query. That is why the chooser reached for `Alt+M`/`Alt+S` instead of single keys. The fix is to intercept the favorite/remove/session keys before the search list consumes them. Confidence: high.

## Proposed Remediation

**Preferred**: Keep the chooser searchable and introduce a consistent, memorable **`Shift`+letter** scheme that does not collide with type-to-search:
- `Shift+A` (uppercase `A`) → add highlighted model to Favorites (if not already a favorite).
- `Shift+R` (uppercase `R`) → remove highlighted model from Favorites (no-op if it isn't a favorite; harmless outside the Favorites tab).
- `Shift+S` (uppercase `S`) → session-only select (replaces `Alt+S`, keeps the feature).
- Remove the `Alt+M` and `Alt+S` branches and their hint text.

Intercept these at the top of `ModelSelectorComponent.handleInput`, **before** `this.list.handleKey(data)`. Uppercase `A`/`R`/`S` are distinguishable from the lowercase `a`/`r`/`s` that `SearchableList` uses for filtering (via `printableChar`/`isPrintableChar`), so search survives. Implement add/remove by reusing the existing `onToggleFavorite` callback: for `A`, call it only when `favoriteAliases` does not contain the selected alias; for `R`, call it only when it does. The host `toggleFavoriteModel` already appends/removes and live-refreshes the tab. Update the hint line (`A favorite · R unfavorite · S session-only`), the `FAVORITES_EMPTY_MESSAGE`, and the two `Alt+M` user-facing strings in `config.ts`.

**Alternatives**:
- Drop searchability from the model chooser (mirror the provider list exactly) so bare `a`/`r`/`s` work without Shift. Simpler binding but removes a useful type-to-search feature the user did not ask to drop — reject unless the user prefers strict parity over search.
- Keep `Alt+M`/`Alt+S` *and* add `A`/`R` as aliases. Violates the explicit "remove the weird combinations" request — reject.

**Files likely to change**:
- `apps/kimi-code/src/tui/components/dialogs/model-selector.ts` (key handling + hints)
- `apps/kimi-code/src/tui/components/dialogs/tabbed-model-selector.ts` (empty message)
- `apps/kimi-code/src/tui/commands/config.ts` (two `Alt+M` strings)
- `apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts` (rework `Alt+M`/hint tests)
- `apps/kimi-code/test/tui/components/dialogs/tabbed-model-selector.test.ts` (update favorite/empty assertions)

**Tests to add or update**:
- `model-selector.test.ts`: `Shift+A` calls `onToggleFavorite` for a non-favorite; `Shift+R` calls it for a favorite and is a no-op otherwise; `Shift+S` calls `onSessionOnlySelect`; lowercase `a`/`r`/`s` still filter search; hint line shows `A favorite · R unfavorite · S session-only` and no longer mentions `Alt+M`/`Alt+S`.
- `tabbed-model-selector.test.ts`: Favorites tab empty message no longer references `Alt+M`; `Shift+A`/`Shift+R` propagate through `TabbedModelSelectorComponent` to the inner selector.

## Risks & Considerations

- **Search collision** (primary risk): bare `a`/`r`/`s` are used by the fuzzy filter; if implemented as plain keys (not Shift), type-to-search breaks for those letters. The Shift+letter scheme avoids this.
- **Scope discipline**: the editor `Alt+M` rotation (`custom-editor.ts`, `editor-keyboard.ts`, `kimi-tui.ts::rotateToNextFavoriteModel`) is a *different* feature (rotate session model from the editor without opening `/model`). Leave it untouched — changing it would regress an unrelated workflow.
- **Session-only feature**: removing `Alt+S` without replacing it (e.g. `Shift+S`) makes session-only model selection unreachable from the picker. Keep a binding.
- **Discoverability**: the hint line is the only in-UI documentation; keep it updated so the new keys are advertised like the provider list's.
- No migration, persistence, or API changes — favorites already persist via `tui.toml` `favorite_models`.

## Decisions (confirmed with user)

- **Key scheme**: `Shift+A` (add to Favorites) / `Shift+R` (remove from Favorites) / `Shift+S` (session-only select). Searchability is preserved — lowercase `a`/`r`/`s` keep filtering, so the shortcuts are the Shift variants. This supersedes the bare-`A` reading of the original request.
- **Session-only**: retained, rebound from `Alt+S` to `Shift+S` (consistent Shift+letter scheme). Not dropped.

## Open Questions

- None remaining. Both clarifications resolved above.
