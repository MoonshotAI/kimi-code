# pi-tui upstream

The fork is the diff against the pinned upstream tree. This file records **why** those diffs exist, not where they live. Paths and function names move when upstream refactors; intents do not.

## Last Sync Point

Update this section after every sync. Do not reuse the previous range.

- **Repo:** `https://github.com/earendil-works/pi.git`
- **Subtree:** `packages/tui`
- **Commit:** `53816d7dcc5ebe3a0eedec3cd07196c3a66d83fd` (2026-09-14; v0.85.1 plus upstream main through this commit)
- **This commit is an upstream marker.** It may not exist in this repo's object database.

## Reconstruct the fork

Done when the **file list** of `packages/tui` at the Last Sync Point versus this directory is on screen, with scaffolding excluded, and every named path has been opened as a per-file diff.

```bash
sha=<sha>
tmp=$(mktemp -d)
git clone --filter=blob:none --sparse https://github.com/earendil-works/pi.git "$tmp/pi"
git -C "$tmp/pi" sparse-checkout set packages/tui
git -C "$tmp/pi" fetch --depth 1 origin "$sha"
git -C "$tmp/pi" checkout --detach FETCH_HEAD
diff -rq \
  --exclude package.json \
  --exclude AGENTS.md \
  --exclude UPSTREAM.md \
  --exclude CHANGELOG.md \
  --exclude vitest.config.ts \
  --exclude node_modules \
  --exclude dist \
  "$tmp/pi/packages/tui" packages/pi-tui
```

Run from the monorepo root. Replace `<sha>` with the Last Sync Point commit. Do not dump a recursive unified diff of the whole tree.

Then diff a named file yourself, for example:

```bash
diff -u "$tmp/pi/packages/tui/src/components/editor.ts" packages/pi-tui/src/components/editor.ts
```

The file list is an index, not the contract. Cards below are the contract: behaviors we must not lose.

For each per-file diff, decide only this:

- If it changes **behavior** already described by a card, keep it.
- If it changes **behavior** no card describes, do not keep it quietly — drop it or add a card.
- Otherwise leave it. Extra files are normal (style, identity, tests, docs). Do not invent cards for them, and do not revert them just to shrink the list.

If a `keep` card has no matching behavior left, mark it `absorbed` (do not delete the card).

## Add a local patch

Done when all of the following hold:

1. The behavior cannot live in `apps/kimi-code/src/tui`.
2. A new intent card is in this file (decision / why not in the app).
3. A test fails without the change and passes with it.
4. Reconstructing the fork shows a per-file diff this card explains.

Prefer an optional argument, callback, or default-off switch. Defaults match upstream.

## Sync from upstream

Done when all of the following hold:

1. The target upstream ref is written down before any copy.
2. Files are ported, not wholesale-copied. New upstream files are added explicitly and read.
3. `package.json` `name`, `exports`, `imports`, and the `test` script stay ours.
4. The fork is reconstructed against the **new** Last Sync Point. Every `keep` intent still has a matching per-file diff, or is marked `absorbed`.
5. `pnpm --filter @moonshot-ai/pi-tui test` passes.
6. The Last Sync Point section is updated to the new commit. Do not reuse the previous range.

When upstream reworked a module (new abstractions, renamed concepts, changed data flow), port by behavior against the intent cards. Do not merge by file identity.

## Intents

Each card: **decision** and **why not in the app**. Status is `keep` or `absorbed`.

### wide-grapheme-does-not-recurse — keep

**Decision:** A single grapheme wider than the terminal does not recurse until the stack overflows.

**Why not in the app:** Wrap lives inside the editor's line breaker, before any host render.

### non-positive-width-is-one-column — keep

**Decision:** A zero or negative reported width is treated as one column before children render.

**Why not in the app:** Width is clamped at the container entry; children never see the illegal value.

### overwide-lines-truncate — keep

**Decision:** A rendered line wider than the terminal is truncated. The renderer does not write a crash log and throw.

**Why not in the app:** The width check is on the differential render path after components return.

### negative-width-repeat-does-not-throw — keep

**Decision:** Blank lines, rules, and editor borders clamp their repeat count to ≥ 0 so a negative width does not throw.

**Why not in the app:** The `repeat` calls sit in built-in component render, not in the host.

### unchanged-lines-reuse-processed-output — keep

**Decision:** A line whose raw string is reference-identical to the previous frame reuses that frame's processed output (truncate, normalize, reset). Steady frames cost pointer compares plus work on changed lines.

**Why not in the app:** This is the main-screen render hot path. The host cannot intercept per-line processing.

### editor-history-host-hooks — keep

**Decision:** The host can filter history entries, decorate a recalled entry, and save/restore its own state next to the history draft.

**Why not in the app:** History recall mutates editor state internally; the host is not on that path unless the editor calls out.

### unbracketed-paste-enter-is-newline — keep

**Decision:** After a rapid burst of unbracketed printable characters, Enter inserts a newline instead of submitting.

**Why not in the app:** Submit-versus-newline is decided when the editor handles Enter, before any host callback.

### set-text-can-keep-paste-markers — keep

**Decision:** Replacing editor text can keep the paste-marker registry for markers that still appear in the new text.

**Why not in the app:** Upstream `setText` always clears the registry. A subclass that rewrites the buffer cannot preserve live markers without this option.

### at-completion-searches-multiple-roots — keep

**Decision:** `@` file completion searches additional workspace roots through fd and dedupes by absolute path.

**Why not in the app:** The file walker is inside the combined autocomplete provider.

### opt-in-inline-slash-autocomplete — keep

**Decision:** When enabled, `/` after whitespace mid-input or at the start of a later line opens autocomplete, and further token characters refresh the in-flight request.

**Why not in the app:** Slash detection is inside the editor's input handler, before the provider runs.

### marked-completion-enter-does-not-submit — keep

**Decision:** Autocomplete items may carry opaque host data. Confirming a host-marked item with Enter applies the completion and does not submit. Unmarked slash completions still submit on Enter.

**Why not in the app:** Enter-to-submit is handled in the editor while the completion list is open.

### autolink-stops-at-cjk-punctuation — keep

**Decision:** A bare URL followed by CJK or full-width punctuation does not swallow those characters into the link text and href. Balanced full-width parentheses stay in the URL, matching GFM's ASCII-paren rule.

**Why not in the app:** Autolink matching is in the markdown tokenizer.

### fullscreen-nav-falls-through-when-idle — keep

**Decision:** Fullscreen can swap the layout root. When the primary scroll view has nothing to scroll, viewport keys go to the focused component. Terminal focus in/out reports are not consumed, so app-level listeners still see them.

**Why not in the app:** Viewport key handling and focus-report consumption sit in the alternate-screen input path.

### input-click-uses-prompt-width — keep

**Decision:** Click-to-position in `Input` subtracts the configured prompt's visible width instead of the default two columns.

**Why not in the app:** The click-to-caret mapping is inside `Input.handleMouse`, before any host callback.

### alt-screen-search-field-forwards-mouse — keep

**Decision:** The fullscreen search component forwards pointer input on its text row to the embedded `Input` with translated coordinates, so the caret can be positioned by mouse. Navigation-button hit regions are unaffected.

**Why not in the app:** The search component and the overlay mouse dispatch both live in the library; the app cannot reach the inner `Input`.

### export-mouse-dispatch-result — keep

**Decision:** The package entry exports the `TuiMouseDispatchResult` type so hosts can type components that delegate mouse events to children.

**Why not in the app:** Type-only export surface; the app cannot name the base `Container.handleMouse` return type without it.

### mouse-dispatch-accounts-for-cropped-rows — keep

**Decision:** When the layout crops an over-tall component to keep its cursor row visible, alternate-screen mouse dispatch includes the box's `lineOffset` in the local coordinate transform and uses the uncropped rendered height, so clicks map to the rows actually displayed.

**Why not in the app:** The crop offset is computed inside the layout engine and the translation happens in the alternate-screen dispatch path.

### input-scroll-origin-aligns-to-grapheme — keep

**Decision:** The cached horizontal-scroll origin used for click mapping in `Input` is the grapheme boundary actually displayed first, not the raw column the scroller chose.

**Why not in the app:** The scroll origin is computed inside `Input.render`; the click mapper only sees the cached value.
