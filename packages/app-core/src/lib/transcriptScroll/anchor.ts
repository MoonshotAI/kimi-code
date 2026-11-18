export interface AnchorPath {
  row: string;
  block?: string;
  child?: number;
}

export interface AnchorCandidate {
  path: AnchorPath;
  el: HTMLElement;
  offset: number;
}

export interface PickOptions {
  rowOnly?: boolean;
}

export interface DomAnchors {
  pick: (viewTop: number, options?: PickOptions) => AnchorCandidate | null;
  resolve: (path: AnchorPath) => HTMLElement | null;
  pathOf: (el: Element) => AnchorPath | null;
}

export const ROW_KEY_ATTRIBUTE = 'data-row-key';
export const BLOCK_KEY_ATTRIBUTE = 'data-block-key';
export const MARKDOWN_ROOT_SELECTOR = '.markdown-renderer';

const ROW_SELECTOR = `[${ROW_KEY_ATTRIBUTE}]`;
const BLOCK_SELECTOR = `[${BLOCK_KEY_ATTRIBUTE}]`;
const OWNER_SELECTOR = `${BLOCK_SELECTOR},${ROW_SELECTOR}`;

export function sameAnchorPath(a: AnchorPath | null | undefined, b: AnchorPath | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.row === b.row && a.block === b.block && a.child === b.child;
}

function intersects(rect: DOMRect, y: number): boolean {
  return rect.height > 0 && rect.top <= y && y < rect.bottom;
}

function ownedChildren(container: Element): Element[] {
  const children: Element[] = [];
  for (const renderer of container.querySelectorAll(MARKDOWN_ROOT_SELECTOR)) {
    if (renderer.parentElement?.closest(OWNER_SELECTOR) !== container) continue;
    children.push(...renderer.children);
  }
  return children;
}

function findByAttribute(root: Element, selector: string, attribute: string, value: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    if (el.getAttribute(attribute) === value) return el;
  }
  return null;
}

export function createDomAnchors(root: HTMLElement): DomAnchors {
  function rowOf(el: Element): HTMLElement | null {
    const row = el.closest<HTMLElement>(ROW_SELECTOR);
    return row && root.contains(row) ? row : null;
  }

  function pick(viewTop: number, options: PickOptions = {}): AnchorCandidate | null {
    let row: HTMLElement | null = null;
    let below: HTMLElement | null = null;
    for (const candidate of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const rect = candidate.getBoundingClientRect();
      if (intersects(rect, viewTop)) {
        row = candidate;
        break;
      }
      if (rect.height > 0 && rect.top > viewTop) {
        below = candidate;
        break;
      }
    }
    const target = row ?? below;
    if (!target) return null;
    const rowKey = target.getAttribute(ROW_KEY_ATTRIBUTE)!;
    if (!row || options.rowOnly) {
      return { path: { row: rowKey }, el: target, offset: target.getBoundingClientRect().top - viewTop };
    }
    let block: HTMLElement | null = null;
    for (const candidate of row.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
      if (rowOf(candidate) === row && intersects(candidate.getBoundingClientRect(), viewTop)) block = candidate;
    }
    const container = block ?? row;
    const path: AnchorPath = { row: rowKey };
    if (block) path.block = block.getAttribute(BLOCK_KEY_ATTRIBUTE)!;
    let el: HTMLElement = container;
    const children = ownedChildren(container);
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof HTMLElement && intersects(child.getBoundingClientRect(), viewTop)) {
        path.child = i;
        el = child;
        break;
      }
    }
    return { path, el, offset: el.getBoundingClientRect().top - viewTop };
  }

  function resolve(path: AnchorPath): HTMLElement | null {
    const row = findByAttribute(root, ROW_SELECTOR, ROW_KEY_ATTRIBUTE, path.row);
    if (!row) return null;
    let container: HTMLElement = row;
    if (path.block !== undefined) {
      const block = findByAttribute(row, BLOCK_SELECTOR, BLOCK_KEY_ATTRIBUTE, path.block);
      if (!block) return row;
      container = block;
    }
    if (path.child === undefined) return container;
    const child = ownedChildren(container)[path.child];
    return child instanceof HTMLElement ? child : container;
  }

  function pathOf(el: Element): AnchorPath | null {
    const row = rowOf(el);
    if (!row) return null;
    const path: AnchorPath = { row: row.getAttribute(ROW_KEY_ATTRIBUTE)! };
    const block = el.closest<HTMLElement>(BLOCK_SELECTOR);
    const container = block && row.contains(block) ? block : row;
    if (container !== row) path.block = container.getAttribute(BLOCK_KEY_ATTRIBUTE)!;
    const children = ownedChildren(container);
    const index = children.findIndex(child => child.contains(el));
    if (index >= 0) path.child = index;
    return path;
  }

  return { pick, resolve, pathOf };
}
