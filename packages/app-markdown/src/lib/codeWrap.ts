
import { iconSvg } from '@moonshot-ai/app-client/icons';
import { CODE_TIP_ATTR } from './codeTooltip';

export const CODE_WRAP_CLASS = 'md-code-wrap';
export const CODE_WRAP_TOGGLE_CLASS = 'md-code-wrap-toggle';
export const CODE_NUMS_CLASS = 'md-code-nums';
export const CODE_NUMS_TOGGLE_CLASS = 'md-code-nums-toggle';

export interface CodeBlockToggleLabels {
  wrap: string;
  unwrap: string;
  showNums: string;
  hideNums: string;
  copy: string;
}

const WRAP_ICON = iconSvg('text-wrap', 'sm');
const UNWRAP_ICON = iconSvg('text-wrap-disabled', 'sm');
const NUMS_ICON = iconSvg('list-numbers', 'sm');

interface ToggleSpec {
  stateClass: string;
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

export const CODE_BLOCK_UNSAFE_CSS = `
:host { color-scheme: inherit; }
pre, code { font-family: var(--markdown-code-font-family); font-size: var(--markdown-code-font-size); line-height: var(--markdown-code-line-height); }
pre { padding-bottom: 0; }
pre[data-overflow] [data-code] { padding-bottom: var(--markdown-code-padding-bottom); max-height: var(--markdown-code-max-height); overflow-y: auto; }
pre[data-overflow="scroll"] [data-code] { overflow-x: auto; }
pre[data-overflow="wrap"] [data-code] { overflow-x: hidden; }
pre[data-overflow="wrap"] [data-line] { white-space: pre-wrap !important; overflow-wrap: anywhere !important; min-height: 1lh; }
[data-line], [data-no-newline] { padding-inline: var(--markdown-code-padding-inline); }
[data-code] { scrollbar-width: none; }
[data-code]::-webkit-scrollbar { display: none; }
pre::selection, pre ::selection {
  background: var(--color-code-selection);
  color: var(--color-code-selection-text);
}
::highlight(kimi-selection-comment-keep) {
  background-color: var(--color-code-selection);
  color: var(--color-code-selection-text);
}
pre[data-md-nums="on"] {
  counter-reset: md-code-line;
  position: relative;
  isolation: isolate;
}
pre[data-md-nums="on"] [data-line] {
  counter-increment: md-code-line;
  padding-left: calc(var(--markdown-code-padding-inline) + var(--md-nums-gutter, 4ch));
}
pre[data-md-nums="on"] [data-no-newline] {
  padding-left: calc(var(--markdown-code-padding-inline) + var(--md-nums-gutter, 4ch));
}
pre[data-md-nums="on"] [data-line]::before {
  content: counter(md-code-line);
  display: inline-block;
  position: sticky;
  left: 0;
  z-index: var(--markdown-z-gutter);
  box-sizing: content-box;
  padding-left: var(--markdown-code-padding-inline);
  padding-right: 1ch;
  background: var(--markdown-code-gutter-background);
  width: calc(var(--md-nums-gutter, 4ch) - 1ch);
  overflow: visible;
  margin-left: calc(-1 * (var(--md-nums-gutter, 4ch) + var(--markdown-code-padding-inline)));
  margin-right: 0;
  text-align: right;
  color: var(--markdown-secondary-icon-color);
  user-select: none;
}
`;

function findToggle(container: HTMLElement, toggleClass: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button.${toggleClass}`);
}

function findActionRow(container: HTMLElement): { row: HTMLElement; anchor: HTMLElement } | null {
  const anchor = container.querySelector<HTMLElement>(
    `.code-block-header .code-action-btn:not([disabled]):not(.${CODE_WRAP_TOGGLE_CLASS}):not(.${CODE_NUMS_TOGGLE_CLASS})`,
  );
  if (!anchor || !anchor.parentElement) return null;
  return { row: anchor.parentElement, anchor };
}

const shadowPreWatchers = new WeakMap<Element, MutationObserver>();

export function applyCodeBlockState(container: HTMLElement): void {
  const host = container.querySelector('diffs-container');
  const root = host?.shadowRoot;
  if (!host || !root) return;
  if (!shadowPreWatchers.has(host)) {
    const observer = new MutationObserver(() => applyCodeBlockState(container));
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
  if (wantedNums === 'on') {
    const digits = String(root.querySelectorAll('[data-line]').length).length;
    const gutter = `${Math.max(digits + 1, 4)}ch`;
    if (pre.style.getPropertyValue('--md-nums-gutter') !== gutter) {
      pre.style.setProperty('--md-nums-gutter', gutter);
    }
  } else if (pre.style.getPropertyValue('--md-nums-gutter')) {
    pre.style.removeProperty('--md-nums-gutter');
  }
}

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
    button.setAttribute(CODE_TIP_ATTR, next.label);
    appliedToggleState.set(button, next);
  }
}

function syncToggleState(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  syncOneToggle(container, NUMS_SPEC, labels);
  syncOneToggle(container, WRAP_SPEC, labels);
  applyCodeBlockState(container);
}

function toggleCodeState(
  container: HTMLElement,
  spec: ToggleSpec,
  labels: CodeBlockToggleLabels,
): void {
  container.classList.toggle(spec.stateClass);
  syncToggleState(container, labels);
}

export function toggleCodeWrap(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  toggleCodeState(container, WRAP_SPEC, labels);
}

export function toggleCodeNums(container: HTMLElement, labels: CodeBlockToggleLabels): void {
  toggleCodeState(container, NUMS_SPEC, labels);
}

const toggleLabels = new WeakMap<HTMLButtonElement, CodeBlockToggleLabels>();

export function ensureCodeCopyTooltip(container: HTMLElement, copy: string): void {
  const actionRow = findActionRow(container);
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
    toggleLabels.set(existing, labels);
    syncOneToggle(container, spec, labels);
    return existing;
  }
  if (!actionRow) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${actionRow.anchor.className} ${spec.toggleClass}`;
  toggleLabels.set(button, labels);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCodeState(container, spec, toggleLabels.get(button) ?? labels);
  });

  const reference =
    spec === NUMS_SPEC
      ? (findToggle(container, WRAP_SPEC.toggleClass) ?? actionRow.anchor)
      : actionRow.anchor;
  actionRow.row.insertBefore(button, reference);
  syncOneToggle(container, spec, labels);
  return button;
}

export function ensureCodeBlockToggles(
  container: HTMLElement,
  labels: CodeBlockToggleLabels,
): HTMLButtonElement | null {
  ensureCodeCopyTooltip(container, labels.copy);
  const actionRow = findActionRow(container);
  if (container.querySelector('diffs-container')) {
    ensureOneToggle(container, actionRow, NUMS_SPEC, labels);
  }
  const wrap = ensureOneToggle(container, actionRow, WRAP_SPEC, labels);
  applyCodeBlockState(container);
  return wrap;
}

export function toggleWrapIndex<T>(wrapped: Set<T>, key: T): boolean {
  const next = !wrapped.has(key);
  if (next) wrapped.add(key);
  else wrapped.delete(key);
  return next;
}

export function diffWrapKeys(codes: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return codes.map((code) => {
    const n = (seen.get(code) ?? 0) + 1;
    seen.set(code, n);
    return `${n}#${code}`;
  });
}

export function pruneWrapKeys<T>(wrapped: Set<T>, keys: readonly T[]): void {
  if (wrapped.size === 0) return;
  const live = new Set(keys);
  for (const key of wrapped) {
    if (!live.has(key)) wrapped.delete(key);
  }
}
