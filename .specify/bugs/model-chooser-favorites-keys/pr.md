# Bug Fix PR: Model chooser favorites use Shift+A/R/S

- **Slug**: model-chooser-favorites-keys
- **Opened**: 2026-08-26
- **PR**: 21
- **URL**: https://github.com/arrrrny/kimi-code-sync/pull/21
- **Branch**: fix/model-chooser-favorites-keys
- **Issue**: n/a (no GitHub issue was filed — internal fork PR)

Replaces the undiscoverable `Alt+M` / `Alt+S` bindings in the `/model` chooser with `Shift+A` (add to Favorites), `Shift+R` (remove from Favorites), and `Shift+S` (session-only select), preserving type-to-search. Updates the Favorites-tab hint, the `/model` notice, and the existing `model-favorites-tui` changeset; adds/updates tests.
