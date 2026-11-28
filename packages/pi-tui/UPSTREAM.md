# pi-tui upstream

The fork is the diff against the pinned upstream tree. This file records **why** those diffs exist, not where they live. Paths and function names move when upstream refactors; intents do not.

## Last Sync Point

Update this section after every sync. Do not reuse the previous range.

- **Repo:** `https://github.com/earendil-works/pi.git`
- **Subtree:** `packages/tui`
- **Commit:** `cf419553da817fefd2f86f170ff3e93eff0bfd28` (2026-11-26; v1.6.1 plus upstream main through this commit)
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

### editor-clear-history — keep

**Decision:** `Editor.clearHistory()` clears the editor's stored prompt history and resets any in-progress history recall index, so a host switching working directories can swap in the new directory's history cleanly.

**Why not in the app:** Prompt history and its recall cursor are private fields on `Editor`; the host cannot clear or reset them without recreating the editor instance.

### unbracketed-paste-enter-is-newline — keep

**Decision:** After a rapid burst of unbracketed printable characters, Enter inserts a newline instead of submitting.

**Why not in the app:** Submit-versus-newline is decided when the editor handles Enter, before any host callback.

### set-text-can-keep-paste-markers — keep

**Decision:** Replacing editor text can keep the paste-marker registry for markers that still appear in the new text.

**Why not in the app:** Upstream `setText` always clears the registry. A subclass that rewrites the buffer cannot preserve live markers without this option.

### at-completion-searches-multiple-roots — keep

**Decision:** `@` file completion searches additional workspace roots through fd and dedupes by absolute path.

**Why not in the app:** The file walker is inside the combined autocomplete provider.

### opt-in-gitignored-at-completion — keep

**Decision:** `CombinedAutocompleteProvider` accepts a default-off `includeGitignoredFiles` option. When enabled, `@` completion scores ordinary fd matches first, supplements them with deduplicated `--no-ignore-vcs` matches unless the 20-item cap is already filled with the highest-scoring ordinary matches, and then ranks by score before ignored status. The existing signal, hidden-file arguments, `.git` exclusions, root fan-out, scoring, and 20-item cap are shared by both phases.

**Why not in the app:** The ordinary and supplemental fd walkers feed the same internal absolute-path dedupe and ranking pipeline. An app wrapper would have to replace that pipeline and could not avoid duplicate scans when the ordinary result already fills the list.

### autocomplete-preserves-literal-wrappers — keep

**Decision:** Path completion tries the prose-stripped token first, then retries the original token when no file matches. Unmatched leading wrappers in real filenames therefore remain valid path characters.

**Why not in the app:** Token extraction and file lookup both live inside the combined autocomplete provider.

### autocomplete-provider-preview-scheduling — keep

**Decision:** Providers may set `autocompleteDebounceMs` and `getAutocompletePreview`. The editor retains the last authoritative suggestions with their input context, applies a provider preview while the existing debounce timer is pending, and always runs the trailing request. Previews never replace the authoritative cache; cancellation clears it. Providers without these optional members retain the upstream 20ms debounce and no-preview behavior.

**Why not in the app:** Debounce, abort/start-token invalidation, request sequencing, and authoritative response acceptance are private editor state. An app-side timer or preview cache would create a second scheduler that could race the editor's own requests.

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

**Decision:** Click-to-position in `Input` subtracts the configured prompt's visible width instead of the default two columns. `Input` implements the optional `SelectionEditComponent` contract and maps in both directions between rendered visual columns and UTF-16 offsets, respecting grapheme boundaries and the horizontal scroll origin. Press, drag, release, and multi-click events remain unhandled so the renderer can select input text; only single clicks move the caret.

**Why not in the app:** Click-to-caret and selection-offset mapping use the input's private rendered range and scroll state inside `Input`, before any host callback.

### alt-screen-search-field-forwards-mouse — keep

**Decision:** The fullscreen search component implements `SelectionEditComponent` through its embedded `Input` and forwards single clicks on its text row with translated coordinates, so the caret can be positioned by mouse. Presses and drags remain available to overlay text selection, and navigation-button hit regions are unaffected. Ordinary drags, including drags outside the input bounds, resolve to logical query offsets clamped to the nearest content endpoint. Triple-click selection covers the complete logical input value without the prompt, result count, or border, including horizontally scrolled-off text. Logical offsets are projected back onto the currently visible columns for highlighting, so the highlight follows horizontal scrolling while copying and editing retain logical text. Multi-click counting remains stable when an intervening render moves the caret and changes the visible word columns.

**Why not in the app:** The search component, its inner input's visual/logical mapping, and overlay mouse dispatch all live in the library; the app cannot reach or reconstruct that private state through composition.

### alt-screen-search-scrollbar-drag — keep

**Decision:** While the transcript search overlay is focused, scrollbar tracks outside its bounds remain hoverable and draggable without moving keyboard focus, but only when no other visible overlay exists, including non-capturing overlays. An existing scrollbar drag owns its drag and release events before search or overlay hit testing; release ends and consumes the gesture regardless of pointer location, so later buttonless motion cannot scroll.

**Why not in the app:** Scrollbar hit testing, overlay focus, and drag state belong to the alternate-screen mouse dispatcher.

### alt-screen-search-delete-selection — keep

**Decision:** With an active selection in the fullscreen search input, the shared `SelectionEditComponent` path used by editors copies logical query text and makes Backspace, Delete, Shift+Backspace, and Shift+Delete remove the selected text rather than the character at the caret. Ordinary printable input, Kitty printable input, modifyOtherKeys printable input, and bracketed paste replace the selection through the shared component transaction during normal input handling. Dragging the focused search selection moves the caret to its active endpoint; a single click clears the selection immediately, and arrow-key caret movement clears it before normal navigation. Ordinary and out-of-bounds drags, triple-click, and keyboard select-all all retain logical offsets, including horizontally scrolled-off text. Deletion places the caret at its start, clears the selection, updates the query, and preserves undo. Search UI text is not editable, and ordinary character deletion is unchanged when no selection is active.

**Why not in the app:** The active screen selection, replacement routing, and overlay keyboard dispatch belong to the alternate-screen renderer, while the inner input owns the logical value, visual/UTF-16 mapping, caret, and undo history.

### alt-screen-search-select-all — keep

**Decision:** `TuiAltScreen` accepts an optional `searchSelectAll` toggle, disabled by default. When enabled, the rebindable `tui.altScreen.searchSelectAll` shortcut, defaulting to Ctrl+Shift+A, selects the complete logical search query without the prompt, result count, or border, including text outside the horizontally visible range. Keyboard selection installs the same logical range as triple-click through the known active search component and overlay identity, without a coordinate hit test, so copying, deletion, and input replacement behave identically even at one to four terminal columns. Highlighting projects the logical endpoints back onto the current visible columns and follows horizontal scrolling; it does not truncate the selection to the initially visible text. The default leaves other hosts' input handling unchanged.

**Why not in the app:** Creating an overlay-bound logical selection and routing the shortcut through the active search overlay require private alternate-screen selection state and the inner input's bidirectional visual/offset mapping.

### editor-selection-editing — keep

**Decision:** `TuiAltScreen` accepts an optional `editorSelection` toggle, disabled by default. `Editor`, `Input`, and `AltScreenSearchComponent` implement the independent, optional `SelectionEditComponent` contract, giving editor and search selections one logical-text path for copying, deletion, replacement by ordinary printable, Kitty printable, modifyOtherKeys printable, or bracketed-paste input, and drag caret following. The renderer uses structural capability guards rather than concrete editor classes, so directly mounted inputs and third-party components receive the same behavior; line, select-all, newline, and offset-to-point projection are optional capabilities. When enabled, the editor maps rendered content cells to document offsets, including grapheme boundaries, wrapping, multiple lines, padding, and scrolling. Logical emptiness is decided from normalized UTF-16 ranges, so dragging across a wide grapheme's two cells selects it while a click or a drag back to the identical visual point remains empty. Padding, border columns, and frame rows clamp to the nearest content endpoint without changing click dispatch. The press anchor fixes visual or logical mode for the gesture: visual selection remains visual when entering an editable region, while logical selection retains its starting component and clamps the active endpoint. Triple-click and select-all install the same logical ranges, including scrolled-off text. A missing select-all capability leaves the current selection intact and passes the shortcut through to normal focused-component input; a missing line capability derives triple-click range from the current content row's start, end, and closest-point mapping, with an empty safe fallback only when that geometry is unavailable. After stable layout, logical endpoints are reprojected onto current rows, origins, and clips; resize never reuses stale highlight geometry, visible clipping never truncates copied or deleted text, and a component without projection safely loses its selection after geometry changes. Backspace, Delete, Shift+Backspace, and Shift+Delete remove the selected offsets with undo support, while arrow-key caret movement clears the selection. Selection copying reads logical text rather than editor UI. Single clicks position the caret and use the immediate input-render path to clear the selection and show the new caret without waiting for a throttled frame. Dragging a focused editor moves its caret to the active selection endpoint, exits history navigation, and refreshes autocomplete. Once a drag starts in an editor, leaving its bounds keeps selection ownership and clamps the active endpoint to the nearest content boundary, including during release. Selecting an unfocused editor does not move its caret. Deleting a selection containing paste markers cleans and renumbers the marker registry while preserving undo. Containers may expose `selectionTargetAt` to delegate nested component coordinates and origins so wrapped editors retain these behaviors.

**Why not in the app:** Visual/logical selection mapping and paste-marker ownership belong to the components, while alternate-screen selection state, shared replacement editing, and keyboard routing are private to the renderer. A container-local coordinate extension is required when the editor is not a direct layout leaf.

### selection-input-transactions — keep

**Decision:** `SelectionEditComponent` may accept the active logical range and selection generation through `handleSelectionInput`. The renderer delegates instead of deleting before the component accepts input, with a compatibility path for components without the capability. Input and Editor share complete-block printable decoding for ordinary Unicode, Kitty CSI-u, and modifyOtherKeys; mixed control blocks, C0/DEL/C1 input, and explicitly unbound keys leave the document and selection unchanged. Shift+Backspace and Shift+Delete are registry-resolved fallback aliases whose defaults yield to explicit user bindings and can be disabled without affecting unrelated default bindings. Character deletion, typed replacement, and bracketed-paste replacement commit through the component's own editing path with one undo snapshot and one change notification. A split paste retains the original range without mutating text until its end marker, and a changed selection generation invalidates that range. Editor replacement expands partial paste-marker endpoints to atomic marker boundaries, rebuilds the registry from surviving old-text references plus newly created large-paste markers, and preserves same-id content while any old reference survives. Newly typed marker-shaped text alone cannot keep an old registry entry alive.

**Why not in the app:** The renderer owns the logical selection, but text acceptance, paste buffering, undo snapshots, autocomplete, marker ownership, and change notifications are private to Input and Editor. An app-side delete-then-insert sequence cannot keep these operations atomic or preserve third-party component behavior.

### export-mouse-dispatch-result — keep

**Decision:** The package entry exports the `TuiMouseDispatchResult` type so hosts can type components that delegate mouse events to children.

**Why not in the app:** Type-only export surface; the app cannot name the base `Container.handleMouse` return type without it.

### export-structured-selection-types — keep

**Decision:** The package entry exports the `TuiSelectionTarget`, `SoftWrapFragment`, and `SoftWrapContinuation` types so hosts can name the return and metadata types used by selection delegation and structured render lines. These exports are type-only and do not change runtime behavior.

**Why not in the app:** Public type surface; hosts implementing `selectionTargetAt` or structured rendering cannot otherwise import these types through the package exports.

### mouse-dispatch-accounts-for-cropped-rows — keep

**Decision:** When the layout crops an over-tall component to keep its cursor row visible, alternate-screen mouse dispatch includes the box's `lineOffset` in the local coordinate transform and uses the uncropped rendered height, so clicks map to the rows actually displayed.

**Why not in the app:** The crop offset is computed inside the layout engine and the translation happens in the alternate-screen dispatch path.

### input-scroll-origin-aligns-to-grapheme — keep

**Decision:** The cached horizontal-scroll origin used for click mapping in `Input` is the grapheme boundary actually displayed first, not the raw column the scroller chose.

**Why not in the app:** The scroll origin is computed inside `Input.render`; the click mapper only sees the cached value.

### viewport-layout-effects — keep

**Decision:** Fullscreen hosts can register synchronous `addLayoutEffect` callbacks after layout and search reveal, before terminal output. An effect's `requestRender` coalesces into another complete layout pass without invalidating component caches; only the settled frame is written. Search keeps its selected occurrence while effect-driven layout shifts rendered rows; selections retain their content when effects only add or remove leading empty rows. Effects must converge within ten passes or rendering throws. With no effects registered, the existing rendering path is preserved.

**Why not in the app:** The settled scroll state and the opportunity to repeat layout before terminal output belong to the alternate-screen render path. Hosts cannot reach this point through component composition alone.

### refocus-mouse-guard — keep

**Decision:** An optional `refocusMouseGuardMs` suppresses mouse-button gestures immediately after a terminal focus-in report, before they can activate controls, move a caret, start a selection, or open a link. The default is zero, focus reports still reach host listeners, and wheel handling is unchanged.

**Why not in the app:** The alternate-screen renderer consumes mouse input before later host listeners and owns the component, selection, and OSC 8 activation paths. The app cannot guard all of them through component composition.

### alt-wheel-acceleration-toggle — keep

**Decision:** `TuiAltScreen` accepts an optional Alt-wheel acceleration toggle and a runtime setter. The default preserves Alt-wheel's five-times multiplier; disabling it leaves Alt-wheel at the configured base line count.

**Why not in the app:** Alt decoding and wheel-delta calculation happen inside the alternate-screen input state machine before the host can route the event.

### right-click-selection-copy — keep

**Decision:** `TuiAltScreen` accepts an optional `copyOnRightClick` toggle and a runtime setter, disabled by default. With a non-empty selection, an unmodified right-click copies it once; success clears only the selection generation that initiated the copy, while failure retains it. Further right-clicks during that pending copy request one paste after success instead of copying again, both for the same selection and after the selection is cleared; failure never requests paste. A replacement selection is neither cleared nor pasted into by the older completion. Each paste callback receives a `TuiRightClickPasteRequest` whose `isCurrent()` checks its increasing request identity and selection-generation snapshot; a copy-triggered clear completes before that snapshot is taken, while later requests and selection changes invalidate older asynchronous reads. Existing zero-argument paste callbacks remain compatible. Selection clipboard writes from copy-on-select, right-click, and programmatic copying run serially in request order, and a rejected write does not block later requests. Clipboard callbacks may return a result object that treats an unverified OSC 52 delivery as completed while preserving its notice. Without an active selection or pending copy, right-click invokes the paste callback on every platform in this mode, including VS Code. The app's clipboard callback sends bracketed paste through `TuiBase.dispatchInput`, so focused editable selections are replaced through the normal input path; platform clipboard reads remain host-owned. Other copy and paste behavior is unchanged by default.

**Why not in the app:** The active selection, right-click dispatch order, clipboard callback, and paste fallback are private to the alternate-screen input path.

### public-dispatch-input — keep

**Decision:** `TuiBase.dispatchInput(data)` publicly dispatches raw input through the same input listeners and focused-component pipeline as terminal input. The app uses it for right-click clipboard paste, delivering bracketed paste so the shared selection-replacement behavior runs without app-side buffer mutation.

**Why not in the app:** Input listeners and focused-component dispatch are private `TuiBase` state. Calling a focused component directly would bypass listeners and the alternate-screen selection-editing route.

### soft-wrap-selection-copy — keep

**Decision:** Internal render rows contain terminal text plus structured soft-wrap fragments. A fragment records its logical-line identity, column range, exact omitted whitespace, generated continuation indentation, an optional producer-origin symbol, and an optional selection-join barrier; vertical layouts preserve fragments and horizontal layouts compose their column ranges. Each component boundary supplies a stable per-component origin only to fragments that lack one, so nested containers retain child producers and all line transforms propagate the origin. Continuation matching compares both producer origin and logical-line identity. Multi-column HStack rendering attaches barriers in both component rendering and layout-engine painting, independently of whether sibling columns contain text or whitespace. Public component rendering and `wrapTextWithAnsi` retain plain string results; custom host components can opt into the structured path through an optional render hook, while other string render overrides remain opaque. Terminal writers consume only the text field. Fullscreen selection copy joins a boundary only when no barrier is present, the logical-line identity and column origin match, the selection covers the boundary, and no other selected non-whitespace fragments would be merged; a zero-width synthetic fragment counts as covered only when its entire zero-width row is selected, so a one-column wide grapheme joins without a spurious newline while virtual-only drags remain empty. Literal newlines and unrelated table or multi-column rows remain intact. Triple-click line selection expands only whole-row soft-wrap fragments without barriers across visual rows; table and multi-column triple-click selections remain on the clicked visual row. Selections that start in an overlay are confined to its visible visual rows and never join underlying wraps. Selections that start in body content continue through overlays and retain logical-line joining, including occluded text.

**Why not in the app:** Logical-line identity is created inside the line breaker and consumed inside alternate-screen selection extraction; neither boundary is available to host code.

### selection-excluded-columns — keep

**Decision:** Components may declare visible-column ranges that are decoration rather than selectable content. Structured render rows carry those ranges through prefixing, truncation, and horizontal composition. The shared decoration-prefix helper combines body-prefix soft-wrap transforms with an exclusion for the actual prefix columns, while the body-prefix helper leaves its prefix selectable; an empty decoration prefix returns the original row. Text, Markdown, and Box use decoration prefixing for the left padding they actually render, including responsive Text padding at narrow widths and Box's own decoration. Heterogeneous containers preserve child-line metadata and attach their own ranges only to rows with the corresponding decoration. Fullscreen selection excludes them from highlighting, word/line selection results, and copied text while leaving pointer geometry, public string rendering, and terminal output unchanged. With no declared ranges, selection behavior matches upstream. Overlay-local selections do not inherit body exclusions and are clipped to the overlay bounds. Body selections retain exclusions through overlays; their highlights are applied before overlay compositing so overlay text is not highlighted. Closing, moving, resizing, or occluding the bound overlay invalidates its selection.

**Why not in the app:** The alternate-screen renderer owns selection highlighting, multi-click ranges, scrolling coordinate transforms, and clipboard extraction. A host-side clipboard filter cannot make decoration columns visually unselectable.

### virtual-line-end-selection-clamp — keep

**Decision:** Mouse selection endpoints in scroll content clamp to the rendered row's visible width when the pointer lies beyond the line end. Every row's unbounded selection edge uses the same content boundary, so first, intermediate, and last rows never highlight terminal padding. Rows without soft-wrap metadata end at the last visible non-whitespace cell; structured rows preserve their declared trailing whitespace and visible suffixes such as table borders. Transcript search uses its horizontally scrolled visible value range, while editors use their rendered visual-line text including padding and wrapping. Dragging from virtual space starts at the actual line end, and virtual-only drags create no selection. A logical editor selection adds one virtual highlight cell for each selected newline, and renders a one-cell block at the next line's content start when that is the active endpoint, including on empty lines. Soft-wrap boundaries and unselected padding remain unhighlighted, and these display cells do not change copied or deleted text.

**Why not in the app:** Search input and editor visual layouts are component-private, and pointer endpoints are resolved inside the alternate-screen renderer before selection highlighting and clipboard extraction.

### read-only-body-selection-newlines — keep

**Decision:** A read-only body selection spanning multiple logical lines shows one reverse-video space at the real line end of each selected hard newline and at the first selectable body column of each selected blank line. Marker placement uses the same soft-wrap boundary decisions as copying, so visual wraps are not mistaken for hard newlines, and accounts for scroll-view coordinates and decoration exclusions. A marker is not drawn when its target cell is occupied by a visible scrollbar or the scroll-to-end prompt; selection highlighting never covers UI. A drag that starts in virtual blank space contributes only the real line-end cell, not the intervening virtual space. Copied text, focus, the bottom editor, and hardware cursor behavior are unchanged.

**Why not in the app:** These display cells are synthesized by the alternate-screen selection renderer from private logical-line and soft-wrap metadata, scroll coordinates, decoration exclusions, and final UI occupancy. Component output and logical selection text do not give the app enough information to place the markers or clip them against chrome without duplicating the render and clipping paths.

### alt-screen-search-editor-selection-focus — keep

**Decision:** While transcript search is active, selecting Editor text does not transfer keyboard focus or the hardware cursor to the editor. With `editorSelection` enabled, the same mouse bypass applies to directly mounted or delegated `SelectionEditComponent` targets, including Input and mouse-aware third-party components: selection press, drag, and release stay on the selection path rather than moving the caret, capturing the mouse, or taking focus. Keyboard input continues to reach the transcript search field throughout a selection drag. A single click follows ordinary component dispatch, closes search, and moves focus and the caret to the editor. With `editorSelection` disabled, non-editable mouse targets retain their existing dispatch and focus behavior.

**Why not in the app:** Structural editable-target hit testing, synthesized click dispatch, focus ownership, and hardware cursor placement are private to the alternate-screen renderer; the host cannot suppress a component's internal caret or mouse-capture mutation after dispatch.

### overlay-selection-excluded-columns — keep

**Decision:** Overlay-local selections honor selection exclusions declared by the overlay component while reading the same structured render that produces the visibly composited terminal text. Each visible overlay is rendered once per frame; those rows supply both terminal output and the flash-free selection snapshot after fake-cursor resolution, height clipping, and width clipping. Highlighting, selection exclusions, word and line selection, and copying share that snapshot, while copy flashes are composited only afterward for terminal output and never enter copied text. Geometry and content versions invalidate ordinary overlay selections when their bounds or rendered selectable content change. The transcript search keeps its logical input selection across caret movement and horizontal scrolling, while geometry, occlusion, and closing still invalidate it. The transcript search excludes its frame, navigation row, prompt prefix, empty-query placeholder, and result status while leaving the query selectable. Overlay metadata adds only exclusion ranges; it does not inherit body exclusions or enable soft-wrap joining. Highlighting translates the overlay-local ranges by the overlay's screen column.

**Why not in the app:** Overlay selection owns private renderer state and needs the structured rows produced inside overlay compositing, so host components cannot attach metadata to the selection source or share that render through composition alone.

### immutable-render-results — keep

**Decision:** `render()`, `[RENDER_LINES]()`, `renderComponentLines()`, and `renderLineTexts()` return snapshots that consumers do not mutate. Legacy string `render()` results are converted afresh at every component boundary rather than cached by array identity, so in-place legacy updates become visible without invalidating an older returned snapshot. Sparse legacy arrays retain their length and holes, conversion visits only populated indices, and line-array composition appends entries without variadic argument expansion so large sparse and dense outputs remain usable. Explicit `[RENDER_LINES]()` results are immutable snapshots: producers and consumers must not modify a returned array, its `TuiRenderLine` objects, or nested soft-wrap and selection metadata. Changes to text, row count or order, or nested metadata require a new top-level array and new objects for the changed rows. Unchanged arrays and rows may be reused. Consumers copy child output before decorating or padding it. Explicit structured conversion and parent caches therefore require no content scans; parent caches compare child row identities rather than text so same-text metadata changes invalidate padded results while reused rows continue to hit, and component-level exclusion callbacks continue to be compared by range values.

**Why not in the app:** Conversion caches and parent render caches are inside pi-tui, while their correctness depends on every host component and container following the same ownership rule. An app-local convention cannot cover other hosts or preserve the rule during upstream synchronization.

### program-status-optional-capability — keep

**Decision:** `Terminal` implementations may omit `setProgramStatus`. Hosts that require reporting declare that capability locally instead of forcing every custom terminal to add a no-op method.

**Why not in the app:** The optional method belongs to the public terminal interface; changing all custom implementations in the app would not make third-party implementations compatible.

### program-status-child-records — keep

**Decision:** OSC 7501 supports `id` and `title`, caches one report per record, clears an id subtree, clears every record during direct-exit restoration, and replays every live record after terminal restart. Invalid ids throw instead of falling back to the root record.

**Why not in the app:** Record replacement, subtree clearing, capability-gated output, and restart replay share the terminal lifecycle that already owns root program status.

### program-status-multiplexer-routing — keep

**Decision:** In tmux, program-status reports and clears use DCS passthrough. Auto mode uses the Rex environment fallback and does not send a support query in tmux, screen, or zellij; explicit enablement still reports the root record.

**Why not in the app:** The terminal owns capability detection, replay, stop, and direct-exit restoration. An app wrapper around ordinary reports would leave the other lifecycle paths unwrapped.

### shared-animation-frames — keep

**Decision:** `requestAnimationFrame` and `cancelAnimationFrame` on the TUI work like the browser's. A request runs once; every callback of a frame gets the same timestamp on the `performance.now()` clock; frames are never replayed after a late wake. By default they land on a fixed `ANIMATION_FRAME_INTERVAL_MS` grid. `setAnimationFrameRate` on `TuiBase` takes a whole number of frames per second from 1 to `MAX_ANIMATION_FRAME_RATE` and throws `RangeError` on anything else; after it, the next frame comes one new interval after the last frame. One unref'd timer serves all requests and exists only while a request is pending. A throwing callback does not stop the other callbacks or later frames, and the first error is rethrown in a microtask. `stop()` pauses frames and keeps the requests; `start()` resumes on the next frame. An optional constructor clock lets tests drive frames by hand. Without one, each scheduler keeps the global timers and `performance.now` it found when it was created, so a running frame chain never moves onto fake timers that a later test installs. With no requests, behavior matches upstream.

**Why not in the app:** Pausing and resuming must follow the renderer's own `stop()` and `start()`, which hosts such as the external editor call directly. One clock in the renderer also lets every animated component share one timer and one frame time. The host sets the frame rate there for the same reason: the timer and the grid belong to the renderer, and no component sees the others' requests.

### scroll-selection-content-regions — keep

**Decision:** Structured scroll rows may attach an optional `selectionRegion` containing a pure content row, its flattened starting column, and its region width. When any row in a `ScrollView` declares one, that scroll view owns one cross-row selection whose endpoints use content-local columns. Presses left of a marked row's content start at content column zero, allowing drags to enter content without selecting gutter text; these presses retain ordinary click dispatch and do not participate in word or line multi-click expansion. Presses on unmarked rows or beyond the region do not start a selection; a rejected press still dispatches an unmodified click through the existing release path, while any subsequent pointer motion suppresses that click and cannot start a selection after entering content. Active drags clamp to the current row's content. Copying, highlighting, word and line selection, soft-wrap joining, and blank-newline markers read the content rows and project through each row's own column and width. Prefix, offset, truncation, and horizontal composition preserve or translate the metadata without changing the content row's soft-wrap metadata. Rows and hosts without this metadata retain the existing selection path.

**Why not in the app:** The flattened rows and their transforms cross private component and layout boundaries, while pointer ownership, multi-click expansion, automatic scrolling, clipboard extraction, and highlight projection are private to the alternate-screen renderer. An app-side filter cannot keep those operations on the same per-row geometry.

### dedicated-scrollbar-layout — keep

**Decision:** `ScrollViewOptions` accepts `scrollbarLayout: "overlay" | "dedicated"`, defaulting to `overlay`. Dedicated layout reserves the rightmost column for both `auto` and `always` whenever the viewport is wider than one column, including while an automatic track is hidden; `hidden` reserves nothing. A one-column viewport keeps its only content column selectable, and a visible automatic track retains the existing overlay hit-testing and gestures. Automatic visibility, proportional geometry, hover, track clicks, dragging, and release reuse the existing scrollbar state machine. A column is excluded from visual text selection only when dedicated layout actually reserves it. Omitting the option preserves overlay sizing and selection behavior.

**Why not in the app:** Content width is allocated inside scroll layout before the child renders, and scrollbar hit testing competes with text selection inside the alternate-screen mouse dispatcher. The app cannot reserve that column or arbitrate those gestures through component composition without duplicating the layout and input state machines.
### alt-screen-search-bindings-and-open-search — keep

**Decision:** Default alternate-screen search keybindings in `TUI_KEYBINDINGS` use `["ctrl+f", "ctrl+shift+f"]` for `tui.altScreen.search`, `["up", "shift+enter", "ctrl+shift+g"]` for `tui.altScreen.searchPrevious`, and `["down", "enter", "ctrl+g"]` for `tui.altScreen.searchNext`. `TuiAltScreen.openSearch(query?)` idempotently opens or refocuses transcript search (when the active layout has a searchable scroll view) and optionally prefills a single-line sanitized query with the cursor at the end via `Input.setCursor(position)` (paired with `Input.getCursor()`). When primary search navigation keys are `up`/`down`, `AltScreenSearchComponent` renders semantic `↑ Previous` and `↓ Next` labels (with narrow fallback `↑ ↓`), and whitespace-only queries do not show `No matches`. The `tui.altScreen.search` binding requires a searchable scroll view so full-screen layout takeovers without a `ScrollView` keep their own `Ctrl+F` handling. While transcript search is active, non-wheel mouse focus transfers to a component outside the search overlay close active search before moving focus, whereas wheel events, clicking search controls, and drag-selecting transcript text keep search open; when search is inactive, wheel focus requests keep upstream semantics.

**Why not in the app:** Default keybindings live in `TUI_KEYBINDINGS` shared by all `pi-tui` components; search overlay lifecycle, `ActiveSearch` state, viewport key dispatch, mouse focus dispatch, search label formatting, and `Input` cursor positioning are private to `TuiAltScreen`, `AltScreenSearchComponent`, and `Input`.

### kitty-caps-lock-modified-letter-normalization — keep

**Decision:** When Kitty CSI-u input reports an uppercase Latin letter (`A`–`Z`) with Caps Lock and any non-lock modifier (`ctrl`, `alt`, `super`, or `shift`) active, key matching and `parseKey` normalize the letter identity to lowercase so modified letter bindings match while plain Caps Lock uppercase text input stays unaffected.

**Why not in the app:** `KeybindingsManager`, `TuiAltScreen`, and all `pi-tui` components dispatch keybindings directly through `keys.ts` before any app component input handler runs.

### box-layout-and-borders — keep

**Decision:** `Box` is a layout-participating `Container` configured via `BoxOptions` (`border`, `borderStyle`, `borderColor`, `title`, `padding`), defaulting to zero padding and no border. In fullscreen layout frames it insets its child clip rectangle inside its border and padding, allocates its inner height to a single child (such as `ScrollView`) or stacks multiple children vertically, renders its frame even when empty, and paints borders outside the child clip so scrollbars and text selection stay inside the frame.

**Why not in the app:** `LAYOUT_NODE` is internal to `pi-tui`; an app-level wrapper around `ScrollView` collapses it into a leaf component without viewport clipping, scrollbar geometry, wheel routing, or offscreen text selection.

### scroll-view-on-scroll-and-overscroll-contain — keep

**Decision:** `ScrollViewOptions.onScroll` notifies callers whenever `scrollTop` changes (via `scrollTo`, `scrollBy`, `scrollToStart`, `scrollToEnd`, or layout clamping), and `TuiAltScreen.routeWheel` zeroes remaining wheel delta when stopping at a `ScrollView` with `overscroll: "contain"` so wheel overscroll does not leak to `primaryScrollView`.

**Why not in the app:** Wheel routing to `primaryScrollView` and scrollbar-drag `scrollTo` happen inside `TuiAltScreen` and `ScrollView`; intercepting `handleMouse` in the app bypassed viewport-only render caching and missed scrollbar drags.

### component-click-horizontal-cell-tolerance — keep

**Decision:** Component-handled pointer gestures synthesize `click` (and preserve consecutive `clickCount`) when the pointer stays on the pressed row and within at most 1 horizontal column (`|dx| <= 1`, `dy === 0`) between `press` and `release`, dispatching `click` at the pressed coordinates.

**Why not in the app:** `TuiAltScreen.handleMouseEvent` suppresses `click` synthesis before calling component mouse handlers whenever `mousePressMoved` flips.
