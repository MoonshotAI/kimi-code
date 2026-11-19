
export function startMentionSelectionSync(getRoot: () => ParentNode | null): () => void {
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
    if (!range || !rootIntersected) {
      for (const pill of marked) pill.classList.remove('pill-in-selection');
      marked = new Set();
      return;
    }
    const covered = new Set<Element>();
    for (const pill of root.querySelectorAll('.mention-pill, .attachment-pill, .quote-pill')) {
      try {
        if (range.intersectsNode(pill)) covered.add(pill);
      } catch {}
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
