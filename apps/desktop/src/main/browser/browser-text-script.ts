/// <reference lib="dom" />
import type { BrowserTextScope, BrowserTextSnapshot } from '../../shared/browser-automation';

interface BrowserElementRefs {
  snapshotId: string;
  elements: Map<string, Element>;
  probe?: { snapshotId: string; elements: Map<string, Element> };
}

export function collectBrowserText(scope: BrowserTextScope): Pick<BrowserTextSnapshot, 'blocks' | 'scanTruncated'> {
  const state = (globalThis as unknown as { __kimiBrowserElementState?: BrowserElementRefs }).__kimiBrowserElementState;
  const root = scope.kind === 'element'
    ? [state, state?.probe].find((entry) => entry?.snapshotId === scope.snapshotId)?.elements.get(scope.ref)
    : document.body;
  if (!root || !root.isConnected) throw new Error(`${scope.kind === 'element' ? 'STALE_ELEMENT' : 'PAGE_NOT_READY'}: text scope is no longer available.`);
  const groups: Array<{ element: Element; kind: string; pieces: string[]; lastRect?: DOMRect }> = [];
  let scanned = 0;
  let characters = 0;
  let scanTruncated = false;
  const parentOf = (node: Node): Element | null => (node as Element).assignedSlot ?? node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
  const ownerOf = (node: Node): { element: Element; kind: string } => {
    let fallback: Element | null = null;
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      const tag = parent.tagName.toLowerCase();
      if (tag === 'tr') return { element: parent, kind: 'table-row' };
      if (tag === 'li') return { element: parent, kind: 'list-item' };
      if (/^h[1-6]$/.test(tag)) return { element: parent, kind: 'heading' };
      if (!fallback && /^(p|pre|blockquote|div|section|article)$/.test(tag)) fallback = parent;
      if (parent === root) break;
    }
    return { element: fallback ?? root, kind: 'paragraph' };
  };
  const stack: Node[] = [root];
  while (stack.length) {
    if (++scanned > 10000 || characters >= 256000) { scanTruncated = true; break; }
    const node = stack.pop()!;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) continue;
      const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
      if (autocomplete.some(token => ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(token))) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) continue;
      const children = element.tagName === 'SLOT' ? (element as HTMLSlotElement).assignedNodes({ flatten: true }) : element.shadowRoot?.childNodes ?? element.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    } else if (node.nodeType === 3 && node.nodeValue) {
      const parent = parentOf(node);
      if (!parent) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (range.getClientRects().length === 0) continue;
      const rect = range.getBoundingClientRect();
      if (scope.kind === 'viewport') {
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      }
      const owner = ownerOf(node);
      let group = groups.at(-1);
      if (group?.element !== owner.element) { group = { ...owner, pieces: [] }; groups.push(group); }
      const remaining = 256000 - characters;
      const value = node.nodeValue.slice(0, remaining);
      const previous = group.lastRect;
      if (previous && (rect.top >= previous.bottom - 0.5 || rect.left > previous.right + 1)) group.pieces.push(' ');
      group.pieces.push(value);
      group.lastRect = rect;
      characters += value.length;
      if (value.length < node.nodeValue.length) { scanTruncated = true; break; }
    }
  }
  const blocks: BrowserTextSnapshot['blocks'] = [];
  let index = 0;
  for (const group of groups) {
    const text = group.pieces.join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const id = `b${++index}`;
    let offset = 0;
    let part = 0;
    while (offset < text.length) {
      if (blocks.length >= 2000) { scanTruncated = true; break; }
      let end = Math.min(offset + 512, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      blocks.push({ id, kind: group.kind, text: text.slice(offset, end), part: ++part, continued: end < text.length });
      offset = end;
    }
    if (blocks.length >= 2000) { scanTruncated ||= index < groups.length || offset < text.length; break; }
  }
  return { blocks, scanTruncated };
}
