// packages/app-composer/src/mentionSelectionSync.ts
// Selection paint for mention and attachment pills. Browsers paint the
// text-selection highlight over text and <img>, but NOT over inline <svg> —
// so a selection crossing a pill used to leave its glyph visibly unselected.
// There's no CSS-only way around it (see csswg-drafts#5395), so we toggle a
// class on the pills the current selection actually covers; the stylesheet
// paints the whole pill with the selection wash on that class.
//
// Covers both surfaces: the composer editor (PM writes the DOM selection)
// and the static message stream.

/** Start watching the document selection; pills under `getRoot()` that
 *  intersect the selection range get `.pill-in-selection`. Returns a
 *  cleanup function. Diffed against the previously marked set: a collapsed
 *  caret (every keystroke / click) just unmarks the last set instead of
 *  rescanning every pill under the root. */
export function startMentionSelectionSync(getRoot: () => ParentNode | null): () => void {
  // Pills carrying the class after the last pass — the diff baseline.
  let marked = new Set<Element>();
  const sync = (): void => {
    const root = getRoot();
    if (!root) return;
    const selection = root.ownerDocument?.getSelection?.() ?? document.getSelection();
    const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    let rootIntersected = false;
    if (range && root instanceof Node) {
      try {
        rootIntersected = range.intersectsNode(root);
      } catch {
        rootIntersected = false;
      }
    }
    // Collapsed caret or a selection outside this root: nothing here can be
    // covered — unmark the last set and stop, no rescan.
    if (!range || !rootIntersected) {
      for (const pill of marked) pill.classList.remove('pill-in-selection');
      marked = new Set();
      return;
    }
    const covered = new Set<Element>();
    for (const pill of root.querySelectorAll('.mention-pill, .attachment-pill')) {
      try {
        if (range.intersectsNode(pill)) covered.add(pill);
      } catch {
        // Detached mid-iteration: treat as uncovered.
      }
    }
    for (const pill of covered) {
      if (!marked.has(pill)) pill.classList.add('pill-in-selection');
    }
    for (const pill of marked) {
      if (!covered.has(pill)) pill.classList.remove('pill-in-selection');
    }
    marked = covered;
  };
  document.addEventListener('selectionchange', sync);
  return () => document.removeEventListener('selectionchange', sync);
}
