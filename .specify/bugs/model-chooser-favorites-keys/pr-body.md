## Related Issue

Internal fork PR on `arrrrny/kimi-code-sync` (no upstream issue linked). Background: `.specify/bugs/model-chooser-favorites-keys/assessment.md`

## Problem

The `/model` chooser hid its favorite (and session-only) actions behind undiscoverable `Alt+M` / `Alt+S` bindings, unlike the `/provider` list which advertises single keys (`A add key`). Users could not remember the combinations.

## What changed

- The `/model` chooser now uses `Shift+A` (add to Favorites), `Shift+R` (remove from Favorites), and `Shift+S` (session-only select) instead of `Alt+M` / `Alt+S`.
- Shortcuts are intercepted before the search filter consumes the character, so type-to-search (lowercase `a`/`r`/`s`) still works.
- Updated the Favorites-tab empty hint and the `/model` "add to Favorites" notice.
- The editor `Alt+M` favorite rotation is intentionally unchanged (a separate feature).
- Updated tests; the `printable-key-guard` (which forbids bare-literal key comparisons) passes.

Fix details: `.specify/bugs/model-chooser-favorites-keys/fix.md`
Verification: `.specify/bugs/model-chooser-favorites-keys/test.md`

## Checklist

- [x] I have read the CONTRIBUTING document.
- [x] I have added tests that prove my feature works.
- [x] Ran gen-changesets skill (updated `.changeset/model-favorites-tui.md`).
- [x] This PR needs no doc update (the keybinding is surfaced via in-UI hints only).
