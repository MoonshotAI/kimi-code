
import { iconSvg } from '@moonshot-ai/app-client/icons';
import { copyTextToClipboard } from './clipboard';
import { CODE_TIP_ATTR } from './codeTooltip';

export const TABLE_WIDE_CLASS = 'md-table-wide';
export const TABLE_TOGGLE_CLASS = 'md-table-toggle';
export const TABLE_COPY_CLASS = 'md-table-copy';
export const TABLE_ACTIONS_CLASS = 'md-table-actions';
export const TABLE_LAYOUT_EVENT = 'kimi-table-layout';

export interface TableWideToggleLabels {
  widen: string;
  restore: string;
  copy: string;
}

export type TableSourceResolver = (wrapper: HTMLElement) => string | null;

const WIDEN_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const RESTORE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const COPY_ICON = iconSvg('copy', 'sm');
const CHECK_ICON = iconSvg('check', 'sm');

const COPY_FEEDBACK_MS = 1400;

const wrapperActions = new WeakMap<HTMLElement, HTMLElement>();

function findActions(wrapper: HTMLElement): HTMLElement | null {
  return wrapperActions.get(wrapper) ?? null;
}

function findToggle(wrapper: HTMLElement): HTMLButtonElement | null {
  return findActions(wrapper)?.querySelector<HTMLButtonElement>(`button.${TABLE_TOGGLE_CLASS}`) ?? null;
}

function syncTableActionLabels(wrapper: HTMLElement, labels: TableWideToggleLabels): void {
  const wide = wrapper.classList.contains(TABLE_WIDE_CLASS);
  const toggleLabel = wide ? labels.restore : labels.widen;
  const toggle = findToggle(wrapper);
  if (toggle && toggle.getAttribute('aria-label') !== toggleLabel) {
    toggle.setAttribute('aria-label', toggleLabel);
    toggle.setAttribute(CODE_TIP_ATTR, toggleLabel);
  }
  const copy = findActions(wrapper)?.querySelector<HTMLButtonElement>(`button.${TABLE_COPY_CLASS}`) ?? null;
  if (copy && copy.getAttribute('aria-label') !== labels.copy) {
    copy.setAttribute('aria-label', labels.copy);
    copy.setAttribute(CODE_TIP_ATTR, labels.copy);
  }
}

export function isTableWideHost(wrapper: HTMLElement): boolean {
  return wrapper.closest('.a-msg .msg') !== null;
}

function tableActionsClippingAncestors(host: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = host.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const overflowX = getComputedStyle(ancestor).overflowX;
    if (overflowX === 'auto' || overflowX === 'hidden' || overflowX === 'scroll' || overflowX === 'clip') {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

function tableActionsClipRight(host: HTMLElement): number {
  let right = Number.POSITIVE_INFINITY;
  for (const ancestor of tableActionsClippingAncestors(host)) {
    const rect = ancestor.getBoundingClientRect();
    right = Math.min(right, rect.left + ancestor.clientWidth);
  }
  return right;
}

export function positionTableActions(wrapper: HTMLElement): void {
  const host = wrapper.parentElement;
  const actions = findActions(wrapper);
  if (!host || !actions) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(actions).columnGap) || 0;
  let left = wrapperRect.right - hostRect.left + gap;
  const actionsWidth = actions.getBoundingClientRect().width;
  const clipRight = tableActionsClipRight(host);
  if (actionsWidth > 0 && left + hostRect.left + actionsWidth + gap > clipRight) {
    left = Math.min(
      wrapperRect.right - hostRect.left - actionsWidth - gap,
      clipRight - hostRect.left - actionsWidth - gap,
    );
  }
  actions.style.left = `${left}px`;
  actions.style.top = `${wrapperRect.top - hostRect.top}px`;
}

const actionsObservers = new WeakMap<HTMLElement, ResizeObserver>();
const actionsFrames = new WeakMap<HTMLElement, number>();
const copyFeedbackTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
const actionedWrappers = new Map<HTMLElement, HTMLElement>();
const wrapperLabels = new WeakMap<HTMLElement, TableWideToggleLabels>();

const TABLE_TRANSITION_FALLBACK_MS = 160;

export function tableWidthTransitionMs(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return TABLE_TRANSITION_FALLBACK_MS;
  const style = getComputedStyle(document.documentElement) as Partial<CSSStyleDeclaration>;
  const raw = typeof style?.getPropertyValue === 'function' ? style.getPropertyValue('--duration-base').trim() : '';
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return TABLE_TRANSITION_FALLBACK_MS;
  return raw.endsWith('ms') ? parsed : parsed * 1000;
}

function trackTableActionsWhileResizing(wrapper: HTMLElement): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const pending = actionsFrames.get(wrapper);
  if (pending !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending);
  const deadline = Date.now() + tableWidthTransitionMs();
  const step = (): void => {
    positionTableActions(wrapper);
    if (Date.now() >= deadline) {
      actionsFrames.delete(wrapper);
      return;
    }
    actionsFrames.set(wrapper, requestAnimationFrame(step));
  };
  actionsFrames.set(wrapper, requestAnimationFrame(step));
}

function destroyTableWideToggle(wrapper: HTMLElement): void {
  actionsObservers.get(wrapper)?.disconnect();
  actionsObservers.delete(wrapper);
  const frame = actionsFrames.get(wrapper);
  if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  actionsFrames.delete(wrapper);
  wrapperLabels.delete(wrapper);
  const actions = wrapperActions.get(wrapper);
  const copy = actions?.querySelector<HTMLButtonElement>(`button.${TABLE_COPY_CLASS}`);
  if (copy) {
    const timer = copyFeedbackTimers.get(copy);
    if (timer !== undefined) clearTimeout(timer);
    copyFeedbackTimers.delete(copy);
  }
  actions?.remove();
  wrapperActions.delete(wrapper);
  actionedWrappers.delete(wrapper);
}

export function pruneTableWideToggles(root: HTMLElement): void {
  for (const [wrapper, home] of actionedWrappers) {
    if (home === root && !root.contains(wrapper)) destroyTableWideToggle(wrapper);
  }
}

export function destroyTableWideToggles(root: HTMLElement): void {
  for (const [wrapper, home] of actionedWrappers) {
    if (home === root) destroyTableWideToggle(wrapper);
  }
}

export function ensureTableWideToggle(
  wrapper: HTMLElement,
  labels: TableWideToggleLabels,
  resolveSource?: TableSourceResolver,
): HTMLButtonElement | null {
  wrapperLabels.set(wrapper, labels);
  const existing = findActions(wrapper);
  if (existing) {
    if (existing.parentElement === wrapper.parentElement) {
      syncTableActionLabels(wrapper, labels);
      return existing.querySelector<HTMLButtonElement>(`button.${TABLE_TOGGLE_CLASS}`);
    }
    destroyTableWideToggle(wrapper);
  }
  if (!isTableWideHost(wrapper)) return null;
  const host = wrapper.parentElement;
  if (!host) return null;

  const actions = document.createElement('div');
  actions.className = TABLE_ACTIONS_CLASS;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = TABLE_TOGGLE_CLASS;
  toggle.innerHTML = WIDEN_ICON;
  toggle.setAttribute('aria-label', labels.widen);
  toggle.setAttribute(CODE_TIP_ATTR, labels.widen);
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleTableWide(wrapper, wrapperLabels.get(wrapper) ?? labels);
  });
  actions.appendChild(toggle);

  if (resolveSource) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = TABLE_COPY_CLASS;
    copy.innerHTML = COPY_ICON;
    copy.setAttribute('aria-label', labels.copy);
    copy.setAttribute(CODE_TIP_ATTR, labels.copy);
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = resolveSource(wrapper);
      if (!source) return;
      void copyTextToClipboard(source).then((ok) => {
        if (!ok) return;
        const previous = copyFeedbackTimers.get(copy);
        if (previous !== undefined) clearTimeout(previous);
        copy.innerHTML = CHECK_ICON;
        copyFeedbackTimers.set(copy, setTimeout(() => {
          copy.innerHTML = COPY_ICON;
          copyFeedbackTimers.delete(copy);
        }, COPY_FEEDBACK_MS));
      });
    });
    actions.appendChild(copy);
  }

  host.insertBefore(actions, wrapper.nextSibling);
  wrapperActions.set(wrapper, actions);
  actionedWrappers.set(wrapper, wrapper.closest('.md') ?? host);

  const observer = new ResizeObserver(() => positionTableActions(wrapper));
  observer.observe(wrapper);
  observer.observe(host);
  for (const ancestor of tableActionsClippingAncestors(host)) observer.observe(ancestor);
  actionsObservers.set(wrapper, observer);

  positionTableActions(wrapper);
  return toggle;
}

export function toggleTableWide(wrapper: HTMLElement, labels: TableWideToggleLabels): void {
  const wide = wrapper.classList.toggle(TABLE_WIDE_CLASS);
  const button = findToggle(wrapper);
  if (button) {
    button.innerHTML = wide ? RESTORE_ICON : WIDEN_ICON;
    const label = wide ? labels.restore : labels.widen;
    button.setAttribute('aria-label', label);
    button.setAttribute(CODE_TIP_ATTR, label);
  }
  positionTableActions(wrapper);
  trackTableActionsWhileResizing(wrapper);
  wrapper.dispatchEvent(new CustomEvent(TABLE_LAYOUT_EVENT, { bubbles: true }));
}
