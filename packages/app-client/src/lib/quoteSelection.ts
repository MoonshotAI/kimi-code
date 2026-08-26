// packages/app-client/src/lib/quoteSelection.ts
// "Selection actions" on assistant messages: selecting text in a reply pops a
// small bubble with three exits — comment / add-to-chat / add-to-side-chat.
// These are the pure formatters that turn the selected text into the markdown
// quote block handed to the composer draft or the side chat, plus the submit
// rewrite that folds a quote PILL back into that same wire form.
import { encodeQuoteSourceHeader, parseQuoteLinks } from '@moonshot-ai/app-composer';

/** The bubble's three exits. */
export type SelectionActionKind = 'comment' | 'quote' | 'sidechat';

/** What the selection bubble emits when the user picks an exit. */
export interface SelectionActionPayload {
  action: SelectionActionKind;
  /** The selected text (already trimmed). */
  quote: string;
  /** Only for `comment` — the user's one-liner. */
  comment?: string;
}

/** closest() that crosses shadow boundaries: an element inside a shadow root
 *  (a code block's Pierre-highlighted content lives in one — AGENTS.md
 *  exception 4) keeps walking via the root's host until the selector matches
 *  or the light DOM runs out. */
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

/** The default container a transcript selection must live in for the quote
 *  bubble to apply: one assistant message's markdown body. */
export const TRANSCRIPT_QUOTE_CONTAINER = '.a-msg .msg';

/** The container a FILE-PREVIEW selection must live in for the quote bubble
 *  to apply: the detail panel's preview body (every content kind — markdown,
 *  code, json, csv, text — mounts under it; iframe kinds never leak a
 *  selection out of their frame). */
export const FILE_PREVIEW_QUOTE_CONTAINER = '.file-preview .fp-body';

/** The shared container a selection must live in for the quote bubble to
 *  apply: BOTH boundary containers of the range must resolve to the SAME
 *  `selector` ancestor — a selection spanning two containers (or anchored
 *  outside one) gets no bubble. The transcript passes `.a-msg .msg` (an
 *  assistant markdown body), the file preview passes `.file-preview
 *  .fp-body`. Takes the range's start/end containers already resolved to
 *  elements (text nodes → parent), so reverse drags need no anchor/focus
 *  juggling. Endpoints inside a code block's shadow root resolve through the
 *  host chain. */
export function sharedQuoteContainer(start: Element | null, end: Element | null, selector = TRANSCRIPT_QUOTE_CONTAINER): Element | null {
  const startContainer = start === null ? null : closestCrossingShadow(start, selector);
  if (startContainer === null) return null;
  const endContainer = end === null ? null : closestCrossingShadow(end, selector);
  return endContainer === startContainer ? startContainer : null;
}

export interface SelectionQuoteAnchor {
  /** Horizontal center of the range rect. */
  x: number;
  /** Top edge of the range rect. */
  y: number;
  /** Bottom edge of the range rect — the down-flip anchor. */
  bottom: number;
  quote: string;
}

/** Climb the composed tree from `el`: parentElement steps, hopping OUT of a
 *  shadow root via its host (a Pierre-highlighted code block's endpoint
 *  lives in one). True when `root` is on the chain. Same composed-path
 *  approach as closestCrossingShadow — cross-tree Range queries like
 *  intersectsNode answer unreliably (or throw) across a shadow boundary, so
 *  this chain is the ownership test instead. */
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

/** Whether the live selection's range belongs to this transcript root — the
 *  document-level selectionchange entry's ownership gate. Without it, a
 *  selection made inside an EMBEDDED pane (side chat, agent detail — which
 *  renders the same .a-msg .msg markup) would pop the MAIN pane's bubble and
 *  route to the main composer. BOTH range endpoints must reach the root via
 *  their composed host chains (text nodes resolve to their parent element;
 *  shadow-tree endpoints hop out through the host). */
export function selectionOwnedByRoot(sel: Selection | null, root: Node | null): boolean {
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0 || root === null) return false;
  const range = sel.getRangeAt(0);
  const toElement = (node: Node | null): Element | null =>
    typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
  const start = toElement(range.startContainer);
  const end = toElement(range.endContainer);
  return start !== null && end !== null && reachesRoot(start, root) && reachesRoot(end, root);
}

/** Evaluate the current selection for the quote bubble: non-collapsed, fully
 *  inside ONE `containerSelector` ancestor (shadow-chain aware via
 *  sharedQuoteContainer — the transcript's default is `.a-msg .msg`, the file
 *  preview passes `.file-preview .fp-body`) — returns the bubble anchor or
 *  null. The quote keeps the selection's ORIGINAL text (leading indentation
 *  is part of a code excerpt's meaning): trim only gates emptiness, and at
 *  most the outer newlines are stripped — inner whitespace is never touched.
 *  Shared by the mouseup AND keyup entries (keyboard selections —
 *  Shift+Arrows, cursor browse mode — fire no mouseup). */
export function selectionQuoteAnchor(sel: Selection | null, containerSelector = TRANSCRIPT_QUOTE_CONTAINER): SelectionQuoteAnchor | null {
  // Multi-range selections (Firefox Ctrl+drag) merge every range's text but
  // validate only the first — a later range could come from another message.
  // Rare path: refuse outright rather than validating range by range.
  if (sel === null || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const raw = sel.toString();
  if (raw.trim().length === 0) return null;
  const quote = raw.replace(/^\n+|\n+$/g, '');
  const range = sel.getRangeAt(0);
  // Text nodes resolve to their parent element; range boundaries are
  // document-ordered, so reverse drags need no anchor/focus juggling.
  const toElement = (node: Node | null): Element | null =>
    typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
  if (sharedQuoteContainer(toElement(range.startContainer), toElement(range.endContainer), containerSelector) === null) return null;
  const rect = range.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top, bottom: rect.bottom, quote };
}

/** Clamp one axis of a floating overlay to the viewport margin, BOTH ends —
 *  the naive `Math.min(pos, viewport - extent - margin)` goes negative when
 *  the overlay is taller/wider than the viewport (small window, high zoom),
 *  cropping it off-screen. Same guard as the mention tooltip's position().
 *  `offset` is the viewport's own top/left displacement (the visualViewport's
 *  offsetTop/offsetLeft under iOS keyboard pan/zoom — the bounds shift with
 *  it instead of starting at 0). */
export function clampOverlayAxis(pos: number, extent: number, viewport: number, margin: number, offset = 0): number {
  return Math.min(Math.max(pos, offset + margin), Math.max(offset + margin, offset + viewport - extent - margin));
}

/** The provenance string for a FILE-PREVIEW quote: `path` alone when the
 *  preview carries no line grid (markdown preview), `path:Lx` / `path:Lx-Ly`
 *  when both range ends resolve to HighlightedCode's data-line rows (code /
 *  csv / text views — the gutter is user-select:none, so a row hit always
 *  means real content). Two degradations keep the locator honest: a view
 *  whose rows are FORMATTED display lines (the JSON pretty-print view when
 *  it actually rewrote the content, or markdown PREVIEW mode whose fenced
 *  code blocks number per block — both marked data-quote-display-lines) has
 *  line numbers that do not exist in the source file, so its quotes carry
 *  the bare path. And both range ends get the symmetric empty-side
 *  adjustment (the quote strips its outer newlines, so a row contributing
 *  nothing but a line break has no real content in the excerpt): an end
 *  point at a row's START excludes that row, and a start point at a row's
 *  END excludes the start row. Emitted as the `from: ` header line of the
 *  quote's wire block (chat-message quotes carry none — their source is the
 *  conversation itself). Returns undefined for an empty path. */
export function captureQuoteSource(sel: Selection | null, path: string): string | undefined {
  if (path.length === 0 || sel === null || sel.isCollapsed || sel.rangeCount !== 1) return undefined;
  const range = sel.getRangeAt(0);
  const lineOf = (node: Node | null): { n: number; row: Element } | null => {
    const el = typeof Element !== 'undefined' && node instanceof Element ? node : (node?.parentElement ?? null);
    if (el === null) return null;
    const row = closestCrossingShadow(el, '[data-line]');
    // A view whose rows are FORMATTED display lines carries a marker —
    // shadow-crossing like the row lookup, since a code block's content may
    // live in a shadow root.
    if (row === null || closestCrossingShadow(row, '[data-quote-display-lines]') !== null) return null;
    const n = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
    return Number.isFinite(n) ? { n, row } : null;
  };
  const a = lineOf(range.startContainer);
  const b = lineOf(range.endContainer);
  if (a === null || b === null) return path;
  const [start, end] = a.n <= b.n ? [a.n, b.n] : [b.n, a.n];
  // Range boundaries are document-ordered, so the end row is always b's —
  // even for a reverse drag.
  const adjustedEnd = range.endOffset === 0 && end > start && atRowStart(b.row, range.endContainer) ? end - 1 : end;
  const adjustedStart = atRowEnd(a.row, range.startContainer, range.startOffset) && start < adjustedEnd ? start + 1 : start;
  return adjustedStart === adjustedEnd ? `${path}:L${adjustedStart}` : `${path}:L${adjustedStart}-L${adjustedEnd}`;
}

/** A range END at a row's very beginning contributes none of that row's
 *  content: every ancestor step from the container up to the row has no
 *  previous CONTENT sibling — the line-number gutters (HighlightedCode's
 *  .hl-gutter, the CSV view's <th>) are user-select:none decoration and
 *  never count as selected content. */
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

/** The mirror of atRowStart for the selection's START: the point is at the
 *  row's very end when the container offset consumes its whole content and
 *  every ancestor step up to the row has no following CONTENT sibling. The
 *  quote strips its leading newlines, so such a row contributes nothing but
 *  a line break to the excerpt. */
function atRowEnd(row: Element, node: Node, offset: number): boolean {
  const contentLength =
    node.nodeType === 3 // TEXT_NODE (the Node global is absent under node-env tests)
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

/** Wrap-around navigation index for a small action menu (the selection
 *  bubble's keyboard model): -1 (nothing focused) enters at the first item
 *  on ArrowDown, the last on ArrowUp. */
export function nextMenuIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Split a pending selection-quote insert queue by session: items for the
 *  active session (or stashed session-less) replay in order; items from a
 *  session the user has left are dropped — a switch discards that session's
 *  queue, so nothing lingers to leak into a later session. */
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

/** Sweep a pending selection-quote queue on a watcher fire: items from
 *  sessions other than the active one are dropped NOW (a switch discards
 *  that session's queue even when the composer never became ready in
 *  between — an A→B→A round trip must not resurrect A's stash), then the
 *  caller replays the survivors. Returns the queue to keep: failed replays
 *  re-queued in order. */
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

/** Join a draft segment and an inserted segment with exactly ONE blank line
 *  between them — trailing newlines of the draft and leading newlines of the
 *  insertion are normalized first, so a segment that already ends with `\n\n`
 *  (a quote block) never produces four consecutive newlines on repeat
 *  inserts. An empty side passes the other through unchanged. */
export function joinDraftSegments(draft: string, insertion: string): string {
  const left = draft.replace(/\n+$/, '');
  const right = insertion.replace(/^\n+/, '');
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left}\n\n${right}`;
}

/** Every line prefixed with `> ` (markdown blockquote). */
export function buildQuoteLines(quote: string): string {
  return quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** `> 引用\n\n` — the block appended to the composer draft. */
export function buildQuoteBlock(quote: string): string {
  return `${buildQuoteLines(quote)}\n\n`;
}

/** The full text for a quote/comment action: quote block + optional comment. */
export function buildQuotePrompt(quote: string, comment?: string): string {
  return buildQuoteBlock(quote) + (comment?.trim() ?? '');
}

/** Rewrite the QUOTE LINKS of a SUBMIT-BOUND text copy (the composer doc and
 *  the persisted draft keep the pill link form; this runs on the outgoing
 *  text only): every quote pill becomes its `> ` blockquote block with its
 *  BUNDLED comment (buildQuotePrompt — `> 引用\n\n评论`), so the wire format
 *  is exactly what the text-era flow produced — the composer-private scheme
 *  never reaches the transcript or the model. ONE space immediately after a
 *  link is eaten: it is the insertion's caret-home separator, so anything the
 *  user typed after the pill lands directly after the block's comment. A pill
 *  EDITED INTO MID-LINE (text typed before it, or a Backspace-merged
 *  paragraph) gets a line break before its block: a blockquote only starts at
 *  a line head, and an inline expansion would degrade to ordinary text for
 *  both the daemon and the renderer. Anything that is not a quote link
 *  survives byte-identical. */
export function rewriteQuoteLinks(text: string): string {
  const matches = parseQuoteLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    cursor = match.end;
    if (text[cursor] === ' ') cursor += 1;
    if (out.length > 0 && !out.endsWith('\n')) out = `${out.replace(/ +$/, '')}\n`;
    // A FILE-PREVIEW quote's provenance leads its block as a `from: …`
    // header line (`path[:Lx-Ly]` — the chat-quote form carries none),
    // single-line encoded (the header never splits on a newline in the path).
    if (match.attrs.source !== undefined && match.attrs.source.length > 0) out += `from: ${encodeQuoteSourceHeader(match.attrs.source)}\n`;
    out += buildQuotePrompt(match.attrs.text, match.attrs.comment);
  }
  out += text.slice(cursor);
  return out;
}
