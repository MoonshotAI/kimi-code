
import { effectScope, watch } from 'vue';
import { anyMenuOpen, ensurePointerTracking, installImeCompositionLatch, isImeKeyEvent, isSyntheticPointerMove, openDialogCount, openSheetCount } from '@moonshot-ai/app-ui';
import { lastPointerPosition } from '@moonshot-ai/app-core/lib';
import { isPointInTooltipHoverRegion } from '@moonshot-ai/app-composer/transcript';
import { iconSvg } from '@moonshot-ai/app-ui/icons';
import { linkUrlParts } from './linkUrl';

export interface LinkTooltipHost {
  openExternalLabel?: () => string;
  openInSidebarLabel?: () => string;
  resolveOpenInSidebar?: () => ((url: string) => void) | undefined;
}

const STYLE_ID = 'md-link-tip-style';
const BUBBLE_CLASS = 'md-link-tip';
const VISIBLE_CLASS = 'md-link-tip--visible';
const TEXT_ID = 'md-link-tip-text';

const STYLE_TEXT = `
.${BUBBLE_CLASS} {
  max-width: var(--p-tip-max-w);
  line-height: round(calc(var(--text-xs) * 1.5), 1px);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.${VISIBLE_CLASS} { opacity: 1; pointer-events: auto; }
.${BUBBLE_CLASS}::before,
.${BUBBLE_CLASS}::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: var(--space-1-5);
}
.${BUBBLE_CLASS}::before { bottom: 100%; }
.${BUBBLE_CLASS}::after { top: 100%; }
.${BUBBLE_CLASS}-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.${BUBBLE_CLASS}-domain { font-weight: var(--weight-semibold); }
.${BUBBLE_CLASS}-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-top: var(--space-1);
  max-width: 100%;
}
.${BUBBLE_CLASS}-action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  flex: 0 1 auto;
  min-width: 0;
  padding: var(--space-05) var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: color-mix(in srgb, currentColor 65%, transparent);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}
.${BUBBLE_CLASS}-action:hover {
  color: var(--color-bg);
  background: color-mix(in srgb, var(--color-bg) 14%, transparent);
}
.${BUBBLE_CLASS}-action:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.${BUBBLE_CLASS}-action svg {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  display: block;
  flex: none;
}
.${BUBBLE_CLASS}-action-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

let started = false;
let host: LinkTooltipHost = {};
let bubble: HTMLElement | null = null;
let visible = false;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let anchor: HTMLAnchorElement | null = null;
let hoverOwner: HTMLAnchorElement | null = null;
let shownHref: string | null = null;

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
const HIDE_GRACE = tokenPx('--duration-fast', 120);
const GAP = tokenPx('--space-1-5', 6);
const MARGIN = tokenPx('--space-2', 8);
const HOVER_SLOP = tokenPx('--space-1', 4);

export function linkTooltipAnchorOf(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (!link) return null;
  if (link.dataset.mdLinkHandled === 'true') return null;
  if (link.closest('svg') !== null) return null;
  if (link.closest('.md') === null) return null;
  if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) return null;
  return link;
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

function buildAction(className: string, label: string, icon: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.innerHTML = icon;
  const textEl = document.createElement('span');
  textEl.className = `${BUBBLE_CLASS}-action-label`;
  textEl.textContent = label;
  button.append(textEl);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hide();
    run();
  });
  return button;
}

function buildContent(href: string): void {
  if (!bubble) return;
  const focusedIndex = [...bubble.querySelectorAll('button')].indexOf(
    document.activeElement as HTMLButtonElement,
  );
  const text = document.createElement('div');
  text.className = `${BUBBLE_CLASS}-text`;
  text.id = TEXT_ID;
  text.setAttribute('role', 'tooltip');
  const parts = linkUrlParts(href);
  if (parts === null) {
    text.textContent = href;
  } else {
    text.append(parts.leading);
    const domain = document.createElement('b');
    domain.className = `${BUBBLE_CLASS}-domain`;
    domain.textContent = parts.domain;
    text.append(domain, parts.trailing);
  }
  const actions = document.createElement('div');
  actions.className = `${BUBBLE_CLASS}-actions`;
  const actionClass = `${BUBBLE_CLASS}-action`;
  actions.append(
    buildAction(actionClass, host.openExternalLabel?.() ?? 'External', iconSvg('external-link', 'sm'), () => {
      window.open(href, '_blank', 'noopener');
    }),
  );
  const openInSidebar = host.resolveOpenInSidebar?.();
  if (openInSidebar !== undefined) {
    actions.append(
      buildAction(actionClass, host.openInSidebarLabel?.() ?? 'Right panel', iconSvg('browser', 'sm'), () => {
        openInSidebar(href);
      }),
    );
  }
  bubble.replaceChildren(text, actions);
  if (focusedIndex >= 0) {
    bubble.querySelectorAll<HTMLElement>('button')[focusedIndex]?.focus();
  }
}

function reveal(el: HTMLAnchorElement): void {
  if (!bubble || anchor !== el || !el.isConnected || suppressed()) return;
  shownHref = el.getAttribute('href') ?? '';
  buildContent(shownHref);
  bubble.style.top = '-9999px';
  bubble.style.left = '0px';
  el.setAttribute('aria-describedby', TEXT_ID);
  bubble.setAttribute('aria-hidden', 'false');
  bubble.removeAttribute('inert');
  bubble.classList.add(VISIBLE_CLASS);
  position();
  visible = true;
}

function show(el: HTMLAnchorElement): void {
  clearHideTimer();
  if (anchor !== el) hide();
  anchor = el;
  if (suppressed() || !bubble) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    showTimer = undefined;
    reveal(el);
  }, SHOW_DELAY());
}

function clearShowTimer(): void {
  window.clearTimeout(showTimer);
  showTimer = undefined;
}

function clearHideTimer(): void {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

function hide(): void {
  clearShowTimer();
  clearHideTimer();
  anchor?.removeAttribute('aria-describedby');
  anchor = null;
  hoverOwner = null;
  shownHref = null;
  if (!bubble) return;
  bubble.classList.remove(VISIBLE_CLASS);
  bubble.setAttribute('aria-hidden', 'true');
  bubble.setAttribute('inert', '');
  visible = false;
}

function scheduleHide(respectPointer = true): void {
  clearShowTimer();
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    if (bubble?.contains(document.activeElement)) return;
    if (respectPointer && pointerWithinHoverRegion()) return;
    hide();
  }, HIDE_GRACE());
}

function pointerWithinHoverRegion(): boolean {
  const { x, y } = lastPointerPosition();
  if (x < 0 || y < 0 || anchor === null || !anchor.isConnected || bubble === null || !visible) {
    return false;
  }
  return isPointInTooltipHoverRegion(
    x,
    y,
    anchor.getBoundingClientRect(),
    bubble.getBoundingClientRect(),
    HOVER_SLOP(),
    GAP(),
  );
}

export function syncLinkTooltipWithAnchor(): void {
  if (!anchor) return;
  if (!anchor.isConnected || linkTooltipAnchorOf(anchor) === null) {
    hide();
    return;
  }
  if (!visible) return;
  const href = anchor.getAttribute('href') ?? '';
  if (href !== shownHref) {
    shownHref = href;
    buildContent(href);
  }
  position();
}

export function hideLinkTooltipIfAnchorWithin(root: HTMLElement | null): void {
  if (anchor && root?.contains(anchor)) hide();
}

function onPointerMove(event: PointerEvent): void {
  if (isSyntheticPointerMove(event)) return;
  const owner = linkTooltipAnchorOf(event.target);
  if (!owner) {
    hoverOwner = null;
    if (event.target instanceof Node && bubble?.contains(event.target)) {
      clearHideTimer();
      return;
    }
    if (pointerWithinHoverRegion()) {
      clearHideTimer();
    } else if (anchor !== null && visible && hideTimer === undefined) {
      scheduleHide();
    }
    return;
  }
  if (owner === hoverOwner) return;
  hoverOwner = owner;
  if (owner === anchor && (visible || showTimer !== undefined)) {
    clearHideTimer();
    return;
  }
  if (bubble?.contains(document.activeElement)) return;
  clearHideTimer();
  hide();
  show(owner);
}

function onMouseout(event: MouseEvent): void {
  if (!anchor || !(event.target instanceof Element) || !anchor.contains(event.target)) return;
  const to = event.relatedTarget;
  if (to instanceof Element && (anchor.contains(to) || bubble?.contains(to))) return;
  scheduleHide();
}

function onFocusin(event: FocusEvent): void {
  if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
  const owner = linkTooltipAnchorOf(event.target);
  if (owner) show(owner);
}

function onFocusout(event: FocusEvent): void {
  if (event.target !== anchor) return;
  const to = event.relatedTarget;
  if (to instanceof Node && bubble?.contains(to)) return;
  scheduleHide(false);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!bubble || anchor === null) return;
  if (isImeKeyEvent(event)) return;
  if (event.key === 'Tab' && event.target === anchor && !event.shiftKey && !visible && showTimer !== undefined) {
    clearShowTimer();
    reveal(anchor);
    if (!visible) return;
    event.preventDefault();
    bubble.querySelector<HTMLElement>('button')?.focus();
    return;
  }
  if (!visible) return;
  if (event.key === 'Escape') {
    const fromBubble = event.target instanceof Node && bubble.contains(event.target);
    if (fromBubble) anchor.focus();
    hide();
    if (fromBubble || event.target === anchor) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const buttons = [...bubble.querySelectorAll<HTMLElement>('button')];
  if (buttons.length === 0) return;
  if (event.target === anchor && !event.shiftKey) {
    event.preventDefault();
    buttons[0]!.focus();
    return;
  }
  if (!(event.target instanceof Node) || !bubble.contains(event.target)) return;
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;
  if ((!event.shiftKey && event.target === last) || (event.shiftKey && event.target === first)) {
    event.preventDefault();
    anchor.focus();
    hide();
  }
}

function onResize(): void {
  hide();
}

function onClickCapture(event: MouseEvent): void {
  if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
  hide();
}

export function ensureLinkTooltip(tooltipHost?: LinkTooltipHost): void {
  if (tooltipHost !== undefined) host = tooltipHost;
  if (started || typeof document === 'undefined') return;
  started = true;
  ensurePointerTracking();
  installImeCompositionLatch();

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }
  bubble = document.createElement('div');
  bubble.className = `ui-tip-surface ${BUBBLE_CLASS}`;
  bubble.id = BUBBLE_CLASS;
  bubble.setAttribute('aria-hidden', 'true');
  bubble.setAttribute('inert', '');
  bubble.addEventListener('mouseenter', clearHideTimer);
  bubble.addEventListener('mouseleave', () => scheduleHide());
  bubble.addEventListener('focusin', clearHideTimer);
  bubble.addEventListener('focusout', (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && (bubble?.contains(to) || anchor?.contains(to))) return;
    scheduleHide(false);
  });
  document.body.appendChild(bubble);

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('mouseout', onMouseout);
  document.addEventListener('focusin', onFocusin);
  document.addEventListener('focusout', onFocusout);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('resize', onResize);
  effectScope(true).run(() => {
    watch(anyMenuOpen, (open) => {
      if (open) hide();
    });
    watch([openDialogCount, openSheetCount], ([dialogs, sheets]) => {
      if (dialogs > 0 || sheets > 0) hide();
    });
  });
}
