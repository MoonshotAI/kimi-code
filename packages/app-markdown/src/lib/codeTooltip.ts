
import { effectScope, watch } from 'vue';
import { anyMenuOpen, ensurePointerTracking, isSyntheticPointerMove } from '@moonshot-ai/app-ui';

export const CODE_TIP_ATTR = 'data-md-tip';

const STYLE_ID = 'md-code-tip-style';
const BUBBLE_CLASS = 'md-code-tip';
const VISIBLE_CLASS = 'md-code-tip--visible';

let started = false;
let bubble: HTMLElement | null = null;
let visible = false;
let showTimer: number | undefined;
let anchor: HTMLElement | null = null;
let hoverOwner: HTMLElement | null = null;

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
  line-height: round(calc(var(--text-xs) * 1.5), 1px);
  overflow-wrap: anywhere;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.${VISIBLE_CLASS} { opacity: 1; }
`;

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
  if (r.top - gap - bh < margin) top = r.bottom + gap;
  let left = r.left + r.width / 2 - bw / 2;

  left = Math.min(Math.max(left, margin), Math.max(margin, vw - margin - bw));
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - bh));

  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}

function suppressed(): boolean {
  return anyMenuOpen.value;
}

function show(el: HTMLElement): void {
  anchor = el;
  if (!tipText(el) || suppressed() || !bubble) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    if (!bubble || anchor !== el || !el.isConnected || suppressed()) return;
    bubble.textContent = tipText(el);
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
  hoverOwner = null;
  if (!bubble) return;
  bubble.classList.remove(VISIBLE_CLASS);
  bubble.setAttribute('aria-hidden', 'true');
  visible = false;
}

export function hideCodeTooltipIfAnchorGone(): void {
  if (anchor && !anchor.isConnected) hide();
}

export function hideCodeTooltipIfAnchorWithin(root: HTMLElement | null): void {
  if (anchor && root?.contains(anchor)) hide();
}

function onPointerMove(event: PointerEvent): void {
  if (isSyntheticPointerMove(event)) return;
  const owner = ownerOf(event.target);
  if (owner === hoverOwner) return;
  hoverOwner = owner;
  if (!owner) return;
  if (owner === anchor && (visible || showTimer !== undefined)) return;
  hide();
  show(owner);
}

function onMouseout(event: MouseEvent): void {
  if (!anchor || !(event.target instanceof Element) || !anchor.contains(event.target)) return;
  const to = event.relatedTarget;
  if (to instanceof Element && anchor.contains(to)) return;
  hide();
}

function onFocusin(event: FocusEvent): void {
  if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
  const owner = ownerOf(event.target);
  if (owner) show(owner);
}

function onFocusout(event: FocusEvent): void {
  if (event.target !== anchor) return;
  hide();
}

function onResize(): void {
  hide();
}

export function ensureCodeTooltip(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  ensurePointerTracking();

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

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('mouseout', onMouseout);
  document.addEventListener('focusin', onFocusin);
  document.addEventListener('focusout', onFocusout);
  document.addEventListener('click', hide, true);
  window.addEventListener('resize', onResize);
  effectScope(true).run(() => {
    watch(anyMenuOpen, (open) => {
      if (open) hide();
    });
  });
}
