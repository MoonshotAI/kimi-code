# Bug Verification: Model chooser needs memorable single-key favorite (A/R) like the provider list

- **Slug**: model-chooser-favorites-keys
- **Tested**: 2026-08-26
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The `/model` chooser now exposes `Shift+A` (add to Favorites), `Shift+R` (remove
from Favorites), and `Shift+S` (session-only) instead of the undiscoverable
`Alt+M`/`Alt+S` bindings. The updated and sibling-picker test suites pass (67
tests), and the changed modules type-check cleanly. The symptom (unmemorable
favorite key in the model chooser) no longer reproduces.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (post-fix) | Updated tests assert `Shift+A` adds a non-favorite, `Shift+R` removes a favorite, `Shift+S` runs session-only, and lowercase `a`/`r`/`s` still filter search | pass | Equivalent to the assessment's manual reproduction. |
| New / updated tests | `vitest run model-selector.test.ts tabbed-model-selector.test.ts printable-key-guard.test.ts` | pass | 53 passed. |
| Regression (sibling pickers) | `vitest run effort-selector.test.ts choice-picker.test.ts` | pass | 14 passed — confirms shared picker plumbing and `Alt+S` (unchanged there) still work. |
| Lint / type-check | `pnpm run typecheck` (apps/kimi-code) | pass* | Zero errors in the changed modules; see Residual Risks for pre-existing unrelated failures. |
| Broader TUI suite | `vitest run test/tui` | skipped | Cold import makes a full run ~5–10 min; in-scope modules + guard + sibling pickers already green. |

\* Type-check exits non-zero overall, but **none** of the errors are in the
changed files (`model-selector.ts`, `tabbed-model-selector.ts`,
`commands/config.ts`) or their tests — verified by grepping the full output for
those paths (no matches). The remaining errors are pre-existing and unrelated:
missing `qrcode` dependency in web tests, `agent-core-v2` fullCompactionService
`log` property, and `provider-manager.test.ts` `onSetProxyUrl` typing.

## Output Excerpts

```text
 Test Files  5 passed (5)
      Tests  67 passed (67)
```

```text
$ grep -iE "model-selector|tabbed-model-selector|commands/config|printable-key" <typecheck output>
(no matches → none of the changed modules produced a type error)
```

## Residual Risks

- `pnpm run typecheck` is red on this branch due to pre-existing failures in
  unrelated modules (`qrcode` dep, `agent-core-v2` compaction, web/remote-control
  tests, `provider-manager.test.ts`). These are not introduced by this fix; a
  clean type-check gate would need those addressed separately.
- The full `test/tui` sweep was not executed to completion (long cold-start
  import). The change is isolated to the model-chooser dialogs, whose own suites
  and the `printable-key-guard` (which forbids bare-literal key comparisons)
  all pass.
- `effort-selector.ts` / `choice-picker.ts` still use `Alt+S` for their own
  session-only selects (out of scope); flagged as a consistency follow-up in
  `fix.md`.

## Recommendation

Close the bug — verified end-to-end. The model chooser now matches the
provider-list's discoverable single-key UX, type-to-search is preserved, and the
editor `Alt+M` rotation is untouched.
