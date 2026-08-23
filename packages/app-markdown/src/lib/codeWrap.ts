// @moonshot-ai/app-markdown — codeWrap.ts
//
// Per-code-block header toggles for chat markdown code blocks: word wrap and
// line numbers (independent, per block, both default OFF). markstream renders
// each block as `.code-block-container > .code-block-header` (header with
// language label + action buttons) at runtime, so — exactly like the
// widen-table toggle (tableWide.ts) — the controls are injected as plain DOM
// rather than as Vue components.
//
// The buttons are inserted into the header's action row in the order
// [numbers, wrap, copy] (copy stays rightmost, its long-standing position),
// and copy the copy button's own class list so every existing
// `.code-action-btn` style (Markdown.vue's Terminal Pro skin + markstream's
// utilities) applies unchanged — no new ad-hoc button CSS.
//
// Toggle state lives on the block container as the `md-code-wrap` /
// `md-code-nums` classes (per block, no persistence). Wrap takes effect
// through two channels:
//   - Light-DOM code paths (streaming plain-text <pre>, the `.code-pre-
//     fallback` shown while the highlighter runs, the plain-pre renderer used
//     for heavy messages): the scoped rule in Markdown.vue
//     (`.code-block-container.md-code-wrap pre`) forces pre-wrap with
//     !important, because the streaming controller stamps white-space inline.
//   - The settled shiki renderer (stream-diffs / pierre) draws inside a
//     shadow root that light-DOM CSS cannot reach. Its own stylesheet keys
//     wrapping off a `data-overflow="scroll"|"wrap"` attribute on the shadow
//     <pre>, and our line-number counter keys off a parallel
//     `data-md-nums="on"|"off"` attribute — both flipped directly by
//     applyCodeBlockState. No re-mount, so streaming/highlight state is never
//     disturbed.
//
// Lifecycle follows tableWide: Markdown.vue only injects once the turn has
// settled (markstream keeps rebuilding block DOM mid-stream), and re-runs
// ensure on every post-settle DOM mutation. ensure is idempotent and also
// re-applies the shadow-pre attributes, so toggle choices survive the
// block's fallback → highlighted content swap; a full container remount
// (theme flip, renderer downgrade) resets state to the defaults, which is
// acceptable.
//
// Because ensure re-runs on every observed mutation, the sync path writes
// NOTHING when a toggle already shows the target state — an unconditional
// innerHTML reset would itself be a childList mutation and loop the
// observer forever (observer → ensure → innerHTML → observer).

import { iconSvg } from '@moonshot-ai/app-client/icons';
import { CODE_TIP_ATTR } from './codeTooltip';

export const CODE_WRAP_CLASS = 'md-code-wrap';
export const CODE_WRAP_TOGGLE_CLASS = 'md-code-wrap-toggle';
export const CODE_NUMS_CLASS = 'md-code-nums';
export const CODE_NUMS_TOGGLE_CLASS = 'md-code-nums-toggle';

export interface CodeBlockToggleLabels {
  /** aria-label/tooltip of the wrap toggle while off (action: enable wrap). */
  wrap: string;
  /** aria-label/tooltip of the wrap toggle while on (action: disable wrap). */
  unwrap: string;
  /** aria-label/tooltip of the numbers toggle while off (action: show). */
  showNums: string;
  /** aria-label/tooltip of the numbers toggle while on (action: hide). */
  hideNums: string;
  /** Tooltip stamped on markstream's own copy button as data-md-tip (its
      built-in tooltip is an English-only bubble, disabled via
      showTooltips: false in Markdown.vue — a localized one served by the
      codeTooltip singleton replaces it). */
  copy: string;
}

// Icons come from the shared registry (design-system §02: raw-DOM contexts
// use iconSvg()) — the tabler text-wrap pair for wrap, list-numbers for the
// numbers toggle, at the action-button size.
const WRAP_ICON = iconSvg('text-wrap', 'sm');
const UNWRAP_ICON = iconSvg('text-wrap-disabled', 'sm');
const NUMS_ICON = iconSvg('list-numbers', 'sm');

interface ToggleSpec {
  /** Container class holding the per-block state. */
  stateClass: string;
  /** Marker class on the injected button (findToggle hook). */
  toggleClass: string;
  iconOn: string;
  iconOff: string;
  labelOn: (labels: CodeBlockToggleLabels) => string;
  labelOff: (labels: CodeBlockToggleLabels) => string;
}

const NUMS_SPEC: ToggleSpec = {
  stateClass: CODE_NUMS_CLASS,
  toggleClass: CODE_NUMS_TOGGLE_CLASS,
  iconOn: NUMS_ICON,
  iconOff: NUMS_ICON,
  labelOn: (l) => l.hideNums,
  labelOff: (l) => l.showNums,
};
const WRAP_SPEC: ToggleSpec = {
  stateClass: CODE_WRAP_CLASS,
  toggleClass: CODE_WRAP_TOGGLE_CLASS,
  iconOn: UNWRAP_ICON,
  iconOff: WRAP_ICON,
  labelOn: (l) => l.unwrap,
  labelOff: (l) => l.wrap,
};

// Host styles for the pierre shadow renderer (the settled shiki path),
// delivered through pierre's unsafeCSS channel (wired in Markdown.vue's
// codeBlockProps): the unsafe layer is pierre's LAST cascade layer, so these
// rules beat its base layer without !important, and :root tokens inherit
// through the shadow boundary.
//
// Three jobs:
//  1. Geometry — pierre hardcodes `padding-inline: 1ch` on every line (~8px
//     at 13px mono) with no option or variable; we align the code column
//     with the header's language icon (--space-3 = 12px).
//  2. Line numbers — a pure-CSS counter gated on the pre's data-md-nums
//     attribute (flipped by applyCodeBlockState from the container's
//     md-code-nums class), so the per-block numbers toggle drives them in
//     BOTH scroll and wrap modes. A real [data-line] gets a number; a
//     wrapped continuation gets none and indents to the code column. The
//     number sits in a 4ch gutter (3ch digits + 1ch gap) carved out of the
//     line's left padding, keeping the gutter's left edge at --space-3.
//     Generated content never enters JS copy or text selection.
//
//  3. Text selection — pierre ships no ::selection rule of its own, so the
//     shadow root shows the UA default (invisible on dark surfaces). The
//     per-theme --color-code-selection tokens keep the major shiki token
//     colors at WCAG 1.4.3 (≥4.5:1, ink not flattened) with the fill at
//     ≈1.5:1 vs the code well (a product floor, not WCAG) — full rationale
//     and the 1.4.11-misuse retrospective live in style.css.
//
// The light-DOM pre paths (streaming plain-text pre, the loading fallback,
// the heavy plain-pre renderer) never show numbers, toggle on or not: their
// code is \n-separated text without per-line elements (a counter has nothing
// to count), and the upstream absolute gutter cannot track wrapped line
// heights. Accepted trade-off — the pierre block is the settled steady
// state; the fallback is transient and the plain-pre renderer is a degraded
// mode for heavy messages.
export const CODE_BLOCK_UNSAFE_CSS = `
[data-line], [data-no-newline] { padding-inline: var(--space-3); }
pre::selection, pre ::selection {
  background: var(--color-code-selection);
  color: var(--color-code-selection-text);
}
pre[data-md-nums="on"] {
  counter-reset: md-code-line;
  position: relative;
  /* Local stacking context: keeps the band and the number ink's z-index
     layers scoped to this pre instead of leaking into the page-level
     stacking context. Inside it the order is row backgrounds < band (1) <
     number ink (2). */
  isolation: isolate;
}
pre[data-md-nums="on"]::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(var(--space-3) + var(--md-nums-gutter, 4ch));
  background: var(--color-selected);
  border-right: var(--p-hairline) solid var(--color-line);
  pointer-events: none;
  user-select: none;
  /* Gutter band + separator as one solid pseudo block (the design system
     forbids gradient backgrounds, so no gradient strip): absolutely
     positioned inside the scroller, so it travels with the numbers on
     horizontal scroll and runs unbroken across wrapped lines. Inside the
     pre's isolated stacking context it sits at z-index:1 — above any
     in-flow row backgrounds, while the number ink is lifted to z-index:2
     above it. The fills wash (--color-selected) is the only rung that
     separates from the code well in BOTH themes — the surface tokens alias
     the well in light mode. */
  z-index: 1;
}
pre[data-md-nums="on"] [data-line] {
  counter-increment: md-code-line;
  padding-left: calc(var(--space-3) + var(--md-nums-gutter, 4ch));
}
pre[data-md-nums="on"] [data-no-newline] {
  padding-left: calc(var(--space-3) + var(--md-nums-gutter, 4ch));
}
pre[data-md-nums="on"] [data-line]::before {
  content: counter(md-code-line);
  display: inline-block;
  /* The gutter tracks --md-nums-gutter (applyCodeBlockState sets it from the
     block's digit count; the 4ch fallback covers ≤999 lines): the number box
     keeps its right edge 1ch off the code column and grows LEFT for wider
     numbers, so 5+-digit numbers never overflow the --space-3 inset and
     clip at the scroll boundary. position:relative + z-index:2 lifts the
     ink above the gutter band (z-index:1). */
  position: relative;
  z-index: 2;
  width: calc(var(--md-nums-gutter, 4ch) - 1ch);
  overflow: visible;
  margin-left: calc(-1 * var(--md-nums-gutter, 4ch));
  margin-right: 1ch;
  text-align: right;
  color: var(--color-text-faint);
  user-select: none;
}
`;

function findToggle(container: HTMLElement, toggleClass: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button.${toggleClass}`);
}

/** The header's action row: the element holding the copy (and any other)
    `.code-action-btn` buttons. Returns null while the block still shows
    markstream's loading placeholder (its action row is visibility:hidden
    with every button disabled) — a later ensure pass retries. The injected
    toggles are excluded from the anchor search: they copy the action-button
    class list, so after injection they would otherwise be found FIRST (they
    sit before the copy button) and the copy title would land on them. */
function findActionRow(container: HTMLElement): { row: HTMLElement; anchor: HTMLElement } | null {
  const anchor = container.querySelector<HTMLElement>(
    `.code-block-header .code-action-btn:not([disabled]):not(.${CODE_WRAP_TOGGLE_CLASS}):not(.${CODE_NUMS_TOGGLE_CLASS})`,
  );
  if (!anchor || !anchor.parentElement) return null;
  return { row: anchor.parentElement, anchor };
}

// One MutationObserver per pierre host, replaying the container's toggle
// state when the shadow content is rebuilt (async highlight completion,
// theme update): the fresh <pre> always comes back with the stock
// scroll/no-numbers attributes, and the host-page observer in Markdown.vue
// only sees light DOM. The watcher callback only ever calls
// applyCodeBlockState, which writes solely on a real mismatch — so the
// replay can never loop (shadow setAttribute re-triggers the watcher at
// most once, then the state already matches). Entries are never disconnected
// by hand: the WeakMap ephemeron lets a removed host (and its observer) be
// collected with its container.
const shadowPreWatchers = new WeakMap<Element, MutationObserver>();

/** Replays the container's toggle state onto the pierre shadow <pre>:
    data-overflow from `md-code-wrap`, data-md-nums from `md-code-nums`.
    No-op when the settled renderer hasn't mounted its shadow root yet (the
    block is still on a light-DOM path); the next ensure pass re-applies.
    Also (re)arms the per-host shadow watcher. */
export function applyCodeBlockState(container: HTMLElement): void {
  const host = container.querySelector('diffs-container');
  const root = host?.shadowRoot;
  if (!host || !root) return;
  if (!shadowPreWatchers.has(host)) {
    const observer = new MutationObserver(() => applyCodeBlockState(container));
    // subtree: pierre may also re-stamp data-overflow on the SAME pre
    // instead of replacing it; attributeFilter keeps that audible.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-overflow', 'data-md-nums'],
    });
    shadowPreWatchers.set(host, observer);
  }
  const pre = root.querySelector<HTMLElement>('pre[data-overflow]');
  if (!pre) return;
  const wantedOverflow = container.classList.contains(CODE_WRAP_CLASS) ? 'wrap' : 'scroll';
  if (pre.getAttribute('data-overflow') !== wantedOverflow) {
    pre.setAttribute('data-overflow', wantedOverflow);
  }
  const wantedNums = container.classList.contains(CODE_NUMS_CLASS) ? 'on' : 'off';
  if (pre.getAttribute('data-md-nums') !== wantedNums) {
    pre.setAttribute('data-md-nums', wantedNums);
  }
  // Size the number gutter to the block's digit count: a fixed 4ch gutter
  // lets 5+-digit numbers overflow the --space-3 inset and clip at the
  // scroll boundary. Recomputed on every replay (shadow rebuilds swap in a
  // fresh pre) — the CSS falls back to 4ch without this property.
  if (wantedNums === 'on') {
    const digits = String(root.querySelectorAll('[data-line]').length).length;
    // Clamp at 4: only widen for 4+ digits — never shrink the common short
    // block's gutter below the 4ch it already had.
    const gutter = `${Math.max(digits + 1, 4)}ch`;
    if (pre.style.getPropertyValue('--md-nums-gutter') !== gutter) {
      pre.style.setProperty('--md-nums-gutter', gutter);
    }
  } else if (pre.style.getPropertyValue('--md-nums-gutter')) {
    pre.style.removeProperty('--md-nums-gutter');
  }
}

// What each toggle button currently shows — the guard that keeps repeated
// ensure passes mutation-free (see the module header).
interface AppliedToggleState {
  icon: string;
  label: string;
  pressed: string;
}
const appliedToggleState = new WeakMap<HTMLButtonElement, AppliedToggleState>();

function syncOneToggle(container: HTMLElement, spec: ToggleSpec, labels: CodeBlockToggleLabels): void {
  const button = findToggle(container, spec.toggleClass);
  if (!button) return;
  const on = container.classList.contains(spec.stateClass);
  const next: AppliedToggleState = {
    icon: on ? spec.iconOn : spec.iconOff,
    label: on ? spec.labelOn(labels) : spec.labelOff(labels),
    pressed: String(on),
  };
  const prev = appliedToggleState.get(button);
  if (
    !prev ||
    prev.icon !== next.icon ||
    prev.label !== next.label ||
    prev.pressed !== next.pressed
  ) {
    button.innerHTML = next.icon;
    button.setAttribute('aria-label', next.label);
    button.setAttribute('aria-pressed', next.pressed);
    // The tooltip rides the shared document-level singleton (codeTooltip.ts)
    // — a native title would only double it (after a multi-second delay).
    button.setAttribute(CODE_TIP_ATTR, next.label);
    appliedToggleState.set(button, next);
  }
}

function syncToggleState(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  syncOneToggle(container, NUMS_SPEC, labels);
  syncOneToggle(container, WRAP_SPEC, labels);
  applyCodeBlockState(container);
}

/** Flip one toggle's state on one block container and sync its
    icon/label/pressed state + the shadow-pre attributes. */
function toggleCodeState(
  container: HTMLElement,
  spec: ToggleSpec,
  labels: CodeBlockToggleLabels,
): void {
  container.classList.toggle(spec.stateClass);
  syncToggleState(container, labels);
}

/** Toggle the wrap state on one block container. */
export function toggleCodeWrap(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  toggleCodeState(container, WRAP_SPEC, labels);
}

/** Toggle the line-numbers state on one block container. */
export function toggleCodeNums(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  toggleCodeState(container, NUMS_SPEC, labels);
}

// The labels each toggle currently speaks. Kept in a WeakMap (not in the
// click closure) so a locale switch can re-label every injected button via a
// later ensure pass without the click handler keeping the FIRST injection's
// language forever.
const toggleLabels = new WeakMap<HTMLButtonElement, CodeBlockToggleLabels>();

/** Stamp the localized tooltip attribute on markstream's own copy button
    (served by the codeTooltip singleton). Runs independently of the toggle
    injection: the copy button is live while the message is still streaming
    (the toggles deliberately wait for the turn to settle), and with
    markstream's English-only bubble disabled (showTooltips: false) this
    attribute is its only tooltip — it must not gate on the settle.
    Idempotent, and the attribute write never reaches the light-DOM childList
    observer, so it cannot loop. */
export function ensureCodeCopyTooltip(container: HTMLElement, copy: string): void {
  const actionRow = findActionRow(container);
  // The anchor IS the copy button (every other header button is disabled in
  // our config — and the injected toggles are excluded by findActionRow).
  if (actionRow && actionRow.anchor.getAttribute(CODE_TIP_ATTR) !== copy) {
    actionRow.anchor.setAttribute(CODE_TIP_ATTR, copy);
  }
}

function ensureOneToggle(
  container: HTMLElement,
  actionRow: { row: HTMLElement; anchor: HTMLElement } | null,
  spec: ToggleSpec,
  labels: CodeBlockToggleLabels,
): HTMLButtonElement | null {
  const existing = findToggle(container, spec.toggleClass);
  if (existing) {
    // Refresh the labels (locale may have changed since injection) and
    // re-assert the state: the block body may have been re-rendered behind
    // the same container (fallback → highlighted swap).
    toggleLabels.set(existing, labels);
    syncOneToggle(container, spec, labels);
    return existing;
  }
  if (!actionRow) return null;

  const button = document.createElement('button');
  button.type = 'button';
  // Inherit the sibling action buttons' full class list (markstream utility
  // classes + `code-action-btn`, which Markdown.vue's skin restyles), so the
  // toggle is visually indistinguishable from the copy button; the marker
  // class is only a hook for findToggle.
  button.className = `${actionRow.anchor.className} ${spec.toggleClass}`;
  toggleLabels.set(button, labels);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Read the CURRENT labels from the map, not the injection-time closure.
    toggleCodeState(container, spec, toggleLabels.get(button) ?? labels);
  });

  // Row order: numbers, wrap, copy. The numbers toggle anchors to the wrap
  // toggle when it already exists (partial rebuild), otherwise to the copy
  // anchor like the wrap toggle.
  const reference =
    spec === NUMS_SPEC
      ? (findToggle(container, WRAP_SPEC.toggleClass) ?? actionRow.anchor)
      : actionRow.anchor;
  actionRow.row.insertBefore(button, reference);
  // Icon/label/pressed are stamped by syncOneToggle (single write path).
  syncOneToggle(container, spec, labels);
  return button;
}

/** Inject the numbers + wrap toggles into a `.code-block-container`'s header
    action row (order: numbers, wrap, copy). Idempotent: refreshes labels +
    state on already-injected toggles (so a locale switch re-labels them),
    and null-safe while the header has no enabled action button to anchor to
    (loading placeholder). Also keeps the copy button's tooltip attribute
    localized (see CodeBlockToggleLabels.copy). Returns the wrap toggle. */
export function ensureCodeBlockToggles(
  container: HTMLElement,
  labels: CodeBlockToggleLabels,
): HTMLButtonElement | null {
  ensureCodeCopyTooltip(container, labels.copy);
  const actionRow = findActionRow(container);
  // The numbers toggle is pierre-only: the light-DOM code paths have no
  // per-line DOM to number (see CODE_BLOCK_UNSAFE_CSS), so a toggle there
  // would click into a no-op. Inject it only once the block has its shadow
  // renderer — heavy plain-pre blocks (markdownPerformance downgrade) never
  // get one and never get the toggle; a shiki block gets it when its
  // fallback swaps to the highlighted block (a later ensure pass re-runs
  // this on the DOM mutation).
  if (container.querySelector('diffs-container')) {
    ensureOneToggle(container, actionRow, NUMS_SPEC, labels);
  }
  const wrap = ensureOneToggle(container, actionRow, WRAP_SPEC, labels);
  // Re-assert the shadow-pre attributes on every pass: the pierre host may
  // have appeared (fallback → highlighted swap) or been rebuilt behind the
  // same container since the last pass. Guarded writes — no loop.
  applyCodeBlockState(container);
  return wrap;
}

/** Flip one key's membership in a wrap-state set (the local ```diff
    renderer's per-block wrap/numbers state in Markdown.vue — see
    diffWrapKeys for the key shape). Returns the new state for `key`.
    Mutates the set — pass a reactive Set so the template re-renders. */
export function toggleWrapIndex<T>(wrapped: Set<T>, key: T): boolean {
  const next = !wrapped.has(key);
  if (next) wrapped.add(key);
  else wrapped.delete(key);
  return next;
}

/** Stable per-block wrap keys for the local ```diff renderer: the block's
    code text prefixed by its 1-based occurrence index among blocks with
    identical code. The key follows each block when the message content
    inserts / removes / reorders segments (same-content blocks keep their
    relative order across resegmentation, and the occurrence count is
    recomputed consistently on every render, including mid-stream growth),
    while identical-content blocks stay independent of each other.

    Accepted boundary (won't fix): removing one of several identical blocks
    (or inserting an identical block before a wrapped one) shifts occurrence
    indexes, so a surviving block can lose its pressed state or inherit a
    twin's. This is inherent to any pure key — (a) two byte-identical blocks
    are visually interchangeable, so a state migrating between them is
    imperceptible to the user; (b) a surviving block merely resets to the
    default, which costs one click and breaks nothing; (c) no key that avoids
    DOM-instance identity can tell identical occurrences apart, and DOM
    identity is exactly what streaming re-renders make unstable — an
    impossible triangle, of which occurrence keys are the best available
    compromise between "follows the block" and "stays independent". */
export function diffWrapKeys(codes: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return codes.map((code) => {
    const n = (seen.get(code) ?? 0) + 1;
    seen.set(code, n);
    return `${n}#${code}`;
  });
}

/** Drop wrap keys whose block no longer exists (a deleted diff block, or
    one whose code was edited — both change the key set). Called with the
    freshly computed render keys so the state Set can't accumulate stale
    entries over a long session. */
export function pruneWrapKeys<T>(wrapped: Set<T>, keys: readonly T[]): void {
  if (wrapped.size === 0) return;
  const live = new Set(keys);
  for (const key of wrapped) {
    if (!live.has(key)) wrapped.delete(key);
  }
}
