import { isApplePlatform } from '@moonshot-ai/app-core/lib';
import { encodeQuoteSourceHeader, expandPastedTextLinks, parseQuoteLinks } from '@moonshot-ai/app-composer/model';

export { SELECTION_QUOTE_ENABLED } from '@moonshot-ai/app-composer/model';

export type SelectionActionKind = 'comment' | 'quote';

export interface SelectionActionPayload {
  action: SelectionActionKind;
  quote: string;
  comment?: string;
}

function closestCrossingShadow(el: Element, selector: string): Element | null {
  let current: Element | null = el;
  while (current !== null) {
    const hit = current.closest(selector);
    if (hit !== null) return hit;
    const root: Node | null = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = root !== null && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export const TRANSCRIPT_QUOTE_CONTAINER = '.a-msg .msg';

export const PANEL_QUOTE_CONTAINER = '.file-preview .fp-body, .changes-pane .dv-lines-wrap, .td .td-body';

export function sharedQuoteContainer(start: Element | null, end: Element | null, selector = TRANSCRIPT_QUOTE_CONTAINER): Element | null {
  const startContainer = start === null ? null : closestCrossingShadow(start, selector);
  if (startContainer === null) return null;
  const endContainer = end === null ? null : closestCrossingShadow(end, selector);
  return endContainer === startContainer ? startContainer : null;
}

export interface SelectionQuoteAnchor {
  x: number;
  y: number;
  bottom: number;
  quote: string;
  px?: number;
  py?: number;
}

function reachesRoot(el: Element, root: Node): boolean {
  let current: Element | null = el;
  while (current !== null) {
    if (current === root) return true;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const parentNode: Node | null = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = parentNode !== null && typeof ShadowRoot !== 'undefined' && parentNode instanceof ShadowRoot ? parentNode.host : null;
  }
  return false;
}

function pointerShadowRange(sel: Selection, event: MouseEvent): Range | null {
  if (typeof ShadowRoot === 'undefined' || typeof sel.getComposedRanges !== 'function') return null;
  const shadowRoots = event.composedPath().filter((node): node is ShadowRoot => node instanceof ShadowRoot);
  if (shadowRoots.length === 0) return null;
  const composed = sel.getComposedRanges({ shadowRoots })[0];
  if (composed === undefined || composed.collapsed) return null;
  const root = composed.startContainer.getRootNode();
  if (!(root instanceof ShadowRoot) || composed.endContainer.getRootNode() !== root) return null;
  const range = document.createRange();
  range.setStart(composed.startContainer, composed.startOffset);
  range.setEnd(composed.endContainer, composed.endOffset);
  return range;
}

function selectionRange(sel: Selection, event?: MouseEvent): Range | null {
  const shadowRange = event === undefined ? null : pointerShadowRange(sel, event);
  if (shadowRange !== null) return shadowRange;
  return sel.isCollapsed || sel.rangeCount === 0 ? null : sel.getRangeAt(0);
}

export function selectionOwnedByRoot(sel: Selection | null, root: Node | null, event?: MouseEvent): boolean {
  if (sel === null || root === null) return false;
  const range = selectionRange(sel, event);
  if (range === null) return false;
  const toElement = (node: Node | null): Element | null =>
    typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
  const start = toElement(range.startContainer);
  const end = toElement(range.endContainer);
  return start !== null && end !== null && reachesRoot(start, root) && (reachesRoot(end, root) || endsAtContainerBoundary(range, root));
}

export function isContextClick(event: MouseEvent): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey && isApplePlatform());
}

export function selectionHitByPointer(sel: Selection | null, event: MouseEvent): boolean {
  const range = sel === null ? null : selectionRange(sel, event);
  if (range === null) return false;
  const tree = range.startContainer.getRootNode();
  const target = event.composedPath().find((node): node is Node => node instanceof Node && node.getRootNode() === tree);
  if (target === undefined || !range.intersectsNode(target)) return false;
  return Array.from(range.getClientRects()).some(
    (rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom,
  );
}

function endsAtContainerBoundary(range: Range, container: Node): boolean {
  if (range.endOffset !== 0 && range.endContainer.nodeType !== 1) return false;
  if (container.getRootNode() !== range.endContainer.getRootNode()) return false;
  const trailing = range.cloneRange();
  trailing.setStart(container, container.childNodes.length);
  return trailing.toString().trim().length === 0;
}

export function selectionQuoteAnchor(sel: Selection | null, containerSelector = TRANSCRIPT_QUOTE_CONTAINER): SelectionQuoteAnchor | null {
  if (sel === null || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const raw = sel.toString();
  if (raw.trim().length === 0) return null;
  const quote = raw.replace(/^\n+|\n+$/g, '');
  let range = sel.getRangeAt(0);
  const toElement = (node: Node | null): Element | null =>
    typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
  const start = toElement(range.startContainer);
  const end = toElement(range.endContainer);
  if (sharedQuoteContainer(start, end, containerSelector) === null) {
    const container = sharedQuoteContainer(start, start, containerSelector);
    if (container === null || !endsAtContainerBoundary(range, container)) return null;
    range = range.cloneRange();
    range.setEnd(container, container.childNodes.length);
  }
  const rect = range.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top, bottom: rect.bottom, quote };
}

export function clampOverlayAxis(pos: number, extent: number, viewport: number, margin: number, offset = 0): number {
  return Math.min(Math.max(pos, offset + margin), Math.max(offset + margin, offset + viewport - extent - margin));
}

export interface OverlayViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OverlayBoundaryRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function constrainOverlayViewport(
  viewport: OverlayViewportRect,
  boundary?: OverlayBoundaryRect | null,
): OverlayViewportRect {
  if (boundary === undefined || boundary === null) return viewport;
  const right = Math.min(viewport.left + viewport.width, boundary.right);
  const bottom = Math.min(viewport.top + viewport.height, boundary.bottom);
  const left = Math.max(viewport.left, boundary.left);
  const top = Math.max(viewport.top, boundary.top);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function captureQuoteSource(sel: Selection | null, path: string): string | undefined {
  if (path.length === 0 || sel === null || sel.isCollapsed || sel.rangeCount !== 1) return undefined;
  const range = sel.getRangeAt(0);
  const lineOf = (node: Node | null): { n: number; row: Element } | null => {
    const el = typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
    if (el === null) return null;
    const row = closestCrossingShadow(el, '[data-line]');
    if (row === null || closestCrossingShadow(row, '[data-quote-display-lines]') !== null) return null;
    const n = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
    return Number.isFinite(n) ? { n, row } : null;
  };
  const a = lineOf(range.startContainer);
  const b = lineOf(range.endContainer);
  if (a === null || b === null) return path;
  const [start, end] = a.n <= b.n ? [a.n, b.n] : [b.n, a.n];
  const adjustedEnd = range.endOffset === 0 && end > start && atRowStart(b.row, range.endContainer) ? end - 1 : end;
  const adjustedStart = atRowEnd(a.row, range.startContainer, range.startOffset) && start < adjustedEnd ? start + 1 : start;
  return adjustedStart === adjustedEnd ? `${path}:L${adjustedStart}` : `${path}:L${adjustedStart}-L${adjustedEnd}`;
}

function atRowStart(row: Element, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null && current !== row) {
    let sibling = current.previousSibling;
    while (sibling !== null && isRowGutter(sibling)) sibling = sibling.previousSibling;
    if (sibling !== null) return false;
    current = current.parentNode;
  }
  return current === row;
}

function atRowEnd(row: Element, node: Node, offset: number): boolean {
  const contentLength =
    node.nodeType === 3
      ? (node.nodeValue?.length ?? 0)
      : typeof Element !== 'undefined' && node instanceof Element
        ? (node.childNodes?.length ?? 0)
        : 0;
  if (offset !== contentLength) return false;
  let current: Node | null = node;
  while (current !== null && current !== row) {
    let sibling = current.nextSibling;
    while (sibling !== null && isRowGutter(sibling)) sibling = sibling.nextSibling;
    if (sibling !== null) return false;
    current = current.parentNode;
  }
  return current === row;
}

function isRowGutter(node: Node): boolean {
  return (
    typeof Element !== 'undefined' &&
    node instanceof Element &&
    (node.classList.contains('hl-gutter') || node.tagName === 'TH')
  );
}

export function nextMenuIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function partitionPendingQuotes<T extends { sessionId?: string }>(
  items: readonly T[],
  activeSessionId: string | undefined,
): { replay: T[]; dropped: T[] } {
  const replay: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    if (item.sessionId && item.sessionId !== activeSessionId) dropped.push(item);
    else replay.push(item);
  }
  return { replay, dropped };
}

export function sweepPendingQuotes<T extends { sessionId?: string }>(
  items: readonly T[],
  activeSessionId: string | undefined,
  replay: (item: T) => boolean,
): T[] {
  const { replay: candidates } = partitionPendingQuotes(items, activeSessionId);
  const remaining: T[] = [];
  for (const item of candidates) {
    if (!replay(item)) remaining.push(item);
  }
  return remaining;
}

export function buildQuoteLines(quote: string): string {
  return quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function buildQuoteBlock(quote: string): string {
  return `${buildQuoteLines(quote)}\n\n`;
}

export function buildQuotePrompt(quote: string, comment?: string): string {
  return buildQuoteBlock(quote) + (comment?.trim() ?? '');
}

export function rewriteQuoteLinks(text: string): string {
  const matches = parseQuoteLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  const appendRawText = (seg: string): void => {
    if (!/\S/.test(seg)) {
      out += seg;
      return;
    }
    if (out.length > 0) {
      out = `${out.replace(/\n{0,2}$/, '')}\n\n\n`;
      out += seg.replace(/^\n+/, '');
      return;
    }
    out += seg;
  };
  for (const match of matches) {
    appendRawText(text.slice(cursor, match.start));
    cursor = match.end;
    if (text[cursor] === ' ') cursor += 1;
    if (out.length > 0 && !out.endsWith('\n\n')) out = `${out.replace(/[ \n]+$/, '')}\n\n`;
    if (match.attrs.source !== undefined && match.attrs.source.length > 0) out += `from: ${encodeQuoteSourceHeader(match.attrs.source)}\n`;
    out += buildQuotePrompt(match.attrs.text, match.attrs.comment);
  }
  appendRawText(text.slice(cursor));
  return out;
}

export function rewriteInlineLinksForSubmit(text: string): string {
  return expandPastedTextLinks(rewriteQuoteLinks(text));
}
