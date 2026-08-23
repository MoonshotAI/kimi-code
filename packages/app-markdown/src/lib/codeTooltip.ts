// @moonshot-ai/app-markdown — codeTooltip.ts
//
// Document-level tooltip singleton for the raw-DOM controls codeWrap.ts
// injects into markstream's code-block headers. Native `title` on those
// buttons is effectively invisible (multi-second OS delay — reported twice
// in review), and a Vue tooltip can't be mounted inside markstream's
// runtime-rendered header (no host template mount point — the same
// structural-exception family as the mention pill's mentionTooltip and the
// toggle injection itself). So the controls carry a `data-md-tip` attribute
// and this singleton serves one shared bubble for all of them, replicating
// the design-system TooltipBubble recipe and behavior contract with plain
// DOM:
//   - show delay/anchor gap/viewport margin read from the design tokens
//     (--duration-tooltip / --space-*), top placement with bottom flip;
//   - hides on leave, click, scroll (capture), resize, and while any menu
//     surface is open (the design-system tooltip rule) — pending timers are
//     cancelled on all of these too, and an anchor removed by a streaming
//     re-render closes the bubble (hideCodeTooltipIfAnchorGone);
//   - dark bubble: --color-text ink on --color-bg, --radius-sm, --z-tooltip,
//     opacity transition on the motion tokens;
//   - text is read from the attribute at SHOW time, so a locale switch just
//     re-stamps the attribute (codeWrap's label sync) and the next hover
//     speaks the new language — the bubble itself holds no state.
//
// Lifecycle: ensureCodeTooltip() is idempotent; Markdown.vue calls it once
// on mount. The document listeners, the lazily-created bubble and the
// menu-watch (a DETACHED effect scope) live for the app's lifetime — they
// must not die with whichever Markdown instance happened to start first.

import { effectScope, watch } from 'vue';
import { anyMenuOpen } from '@moonshot-ai/app-ui';

export const CODE_TIP_ATTR = 'data-md-tip';

const STYLE_ID = 'md-code-tip-style';
const BUBBLE_CLASS = 'md-code-tip';
const VISIBLE_CLASS = 'md-code-tip--visible';

let started = false;
let bubble: HTMLElement | null = null;
let visible = false;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let anchor: HTMLElement | null = null;

const STYLE_TEXT = `
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: var(--z-tooltip);
  max-width: var(--p-tip-max-w);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-text);
  color: var(--color-bg);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  /* Integer-px line height off the token, same recipe as .mention-tip. */
  line-height: round(calc(var(--text-xs) * 1.5), 1px);
  overflow-wrap: anywhere;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.${VISIBLE_CLASS} { opacity: 1; }
`;

// Timing/geometry come from the design tokens (read from the computed style,
// so a spacing/motion scale adjustment reaches this singleton too — the same
// tokenPx pattern as mentionTooltip); the literal fallback only covers a
// missing token.
function tokenPx(name: string, fallback: number): () => number {
  let cached: number | undefined;
  return () => {
    if (cached === undefined) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const parsed = parseFloat(raw);
      cached = Number.isFinite(parsed) ? parsed : fallback;
    }
    return cached;
  };
}
const SHOW_DELAY = tokenPx('--duration-tooltip', 150);
const GAP = tokenPx('--space-1-5', 6);
const MARGIN = tokenPx('--space-2', 8);

function tipText(el: HTMLElement): string {
  return el.getAttribute(CODE_TIP_ATTR) ?? '';
}

function ownerOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(`[${CODE_TIP_ATTR}]`) : null;
}

function position(): void {
  if (!bubble || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const gap = GAP();
  const margin = MARGIN();
  let top = r.top - gap - bh;
  // Flip below the anchor when there is no room above (mirrors TooltipBubble).
  if (r.top - gap - bh < margin) top = r.bottom + gap;
  let left = r.left + r.width / 2 - bw / 2;

  left = Math.min(Math.max(left, margin), Math.max(margin, vw - margin - bw));
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - bh));

  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}

// The design-system tooltip rule: while any menu surface is open, hints
// OUTSIDE it must not appear. Every anchor this singleton serves is a
// code-block header button — never inside a menu surface — so "any menu
// open" alone is the suppression condition.
function suppressed(): boolean {
  return anyMenuOpen.value;
}

function show(el: HTMLElement): void {
  anchor = el;
  if (!tipText(el) || suppressed() || !bubble) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    // Re-check at FIRE time: the delay is 150ms, and a menu opening (or any
    // other suppressor) in between must not strand a tip above it.
    if (!bubble || anchor !== el || !el.isConnected || suppressed()) return;
    bubble.textContent = tipText(el);
    // Measure off-screen, then place and fade in (same two-step as
    // TooltipBubble's positioned flag).
    bubble.style.top = '-9999px';
    bubble.style.left = '0px';
    bubble.setAttribute('aria-hidden', 'false');
    bubble.classList.add(VISIBLE_CLASS);
    position();
    visible = true;
  }, SHOW_DELAY());
}

function hide(): void {
  window.clearTimeout(showTimer);
  showTimer = undefined;
  anchor = null;
  if (!bubble) return;
  bubble.classList.remove(VISIBLE_CLASS);
  // opacity:0 + pointer-events:none does NOT leave the a11y tree — a stale
  // tooltip with role="tooltip" would still be reachable in browse mode.
  bubble.setAttribute('aria-hidden', 'true');
  visible = false;
}

/** Close the bubble if its anchor was removed from the document (a streaming
    re-render can swap the header out without a mouseout ever firing — the
    tip would otherwise hang off a dead element). Markdown.vue calls this
    from its DOM-mutation pipeline, so a rebuild closes the tip on the same
    pass. */
export function hideCodeTooltipIfAnchorGone(): void {
  if (anchor && !anchor.isConnected) hide();
}

/** Close the bubble if its anchor lives inside `root`. A Markdown instance
    calls this on UNMOUNT: navigating away removes the root without a
    mouseout, and the mutation pipeline that covers streaming rebuilds stops
    with the component. The ownership check matters because the singleton is
    shared by every live Markdown instance — an unmounting instance must not
    close a tip anchored in ANOTHER instance that is still on screen. */
export function hideCodeTooltipIfAnchorWithin(root: HTMLElement | null): void {
  if (anchor && root?.contains(anchor)) hide();
}

function onMouseover(event: MouseEvent): void {
  const owner = ownerOf(event.target);
  if (owner === anchor && (visible || showTimer !== undefined)) return;
  // Only react to events on tip owners. An UNRELATED target must not close
  // the current tip — least of all one shown via keyboard focus while the
  // pointer roams elsewhere (leaving the anchor is mouseout's job).
  if (owner) {
    hide();
    show(owner);
  }
}

function onMouseout(event: MouseEvent): void {
  // Only the anchor's own departure hides: every mouseout in the document
  // bubbles here, and an unrelated one must not close the tip.
  if (!anchor || !(event.target instanceof Element) || !anchor.contains(event.target)) return;
  const to = event.relatedTarget;
  if (to instanceof Element && anchor.contains(to)) return;
  hide();
}

function onFocusin(event: FocusEvent): void {
  const owner = ownerOf(event.target);
  if (owner) show(owner);
}

function onFocusout(event: FocusEvent): void {
  // Same scoping: some other element losing focus is not our anchor leaving.
  if (event.target !== anchor) return;
  hide();
}

function onScrollOrResize(): void {
  // Cancel unconditionally — a pending timer must not show a tip for an
  // anchor the pointer has already left (the scroll moved it away).
  hide();
}

/** Start the singleton (idempotent). Wires document-level delegation and
    injects the bubble's token-based stylesheet once. */
export function ensureCodeTooltip(): void {
  if (started || typeof document === 'undefined') return;
  started = true;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }
  bubble = document.createElement('div');
  bubble.className = BUBBLE_CLASS;
  bubble.setAttribute('role', 'tooltip');
  bubble.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bubble);

  document.addEventListener('mouseover', onMouseover);
  document.addEventListener('mouseout', onMouseout);
  document.addEventListener('focusin', onFocusin);
  document.addEventListener('focusout', onFocusout);
  document.addEventListener('click', hide, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  // A menu opening hides the hint immediately AND cancels any pending show
  // timer (hide clears it). Detached effect scope: this watch must outlive
  // whichever Markdown instance started the singleton first.
  effectScope(true).run(() => {
    watch(anyMenuOpen, (open) => {
      if (open) hide();
    });
  });
}
