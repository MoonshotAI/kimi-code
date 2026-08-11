// @moonshot-ai/app-markdown — tableWide.ts
//
// Manual "widen table" toggle for chat markdown tables. markstream renders
// tables as `.table-node-wrapper > table.table-node` at runtime, so the
// control is injected as plain DOM (same pattern as the file-link buttons in
// Markdown.vue) rather than as a Vue component.
//
// Two absolutely-positioned overlays are appended to the wrapper:
// - `.md-table-fade`: a gradient fade at the right edge signalling "there is
//   more content" while the table is clipped (hidden once scrolled to the
//   end), and
// - `.md-table-toggle`: a Notion-style icon chip at the top-right corner
//   (hover/focus-within/wide → visible) that toggles the breakout.
// Because children of a scroll container scroll with the content, both are
// translated back by `scrollLeft` on every scroll event, keeping them pinned
// to the visible right edge (see pinTableWideToggle).
//
// Cross-file contract:
// - The breakout CSS lives in each app's ChatPane.vue, gated on the
//   `md-table-wide` class (`.a-msg .msg .table-node-wrapper.md-table-wide`),
//   inside `@container (min-width: 760px)`. This module only toggles the
//   class; without that host CSS the overlays stay hidden (see Markdown.vue's
//   `.md-table-toggle` / `.md-table-fade` rules) and the class has no effect.
// - ConversationPane.vue listens for `kimi-table-layout` (bubbles) to re-run
//   its TOC-rail occlusion hit test when a table's geometry changes without
//   a scroll.

export const TABLE_WIDE_CLASS = 'md-table-wide';
export const TABLE_TOGGLE_CLASS = 'md-table-toggle';
export const TABLE_FADE_CLASS = 'md-table-fade';
export const TABLE_TOGGLE_SHOW_CLASS = 'md-table-toggle--show';
export const TABLE_AT_END_CLASS = 'md-table-at-end';
export const TABLE_LAYOUT_EVENT = 'kimi-table-layout';

export interface TableWideToggleLabels {
  /** aria-label/title while the table is at default (reading-column) width. */
  widen: string;
  /** aria-label/title while the table is widened. */
  restore: string;
}

// feather `maximize-2` / `minimize-2` — the standard ⤢/⤡ expand-collapse pair.
const WIDEN_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const RESTORE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

function findToggle(wrapper: HTMLElement): HTMLButtonElement | null {
  return wrapper.querySelector<HTMLButtonElement>(`button.${TABLE_TOGGLE_CLASS}`);
}

function findFade(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(`.${TABLE_FADE_CLASS}`);
}

const CHIP_SIZE_PX = 26;

/** Centre the chip vertically on the table's header row and mirror the same
    inset to the right edge (top == right), so it sits squarely within the
    header instead of floating at a fixed offset. The header sits a few px
    below the wrapper's top edge (the table's own margin + border), so the
    inset is measured from the header's actual position, not from the
    wrapper's top. Header height varies with cell content and column width,
    so this is re-measured on every visibility update (inject / toggle /
    column resize). */
function alignTableWideToggle(wrapper: HTMLElement): void {
  const button = findToggle(wrapper);
  if (!button) return;
  const header = wrapper.querySelector('thead tr') ?? wrapper.querySelector('tr');
  if (!header) return;
  const headerRect = header.getBoundingClientRect();
  const wrapperTop = wrapper.getBoundingClientRect().top;
  const inset = Math.max(
    2,
    Math.round(headerRect.top - wrapperTop + (headerRect.height - CHIP_SIZE_PX) / 2),
  );
  button.style.top = `${inset}px`;
  button.style.right = `${inset}px`;
}

/** True when the wrapper sits in the one context whose stylesheet provides
    the `md-table-wide` breakout: an assistant chat message in ChatPane. */
export function isTableWideHost(wrapper: HTMLElement): boolean {
  return wrapper.closest('.a-msg .msg') !== null;
}

function tableOverflows(wrapper: HTMLElement): boolean {
  const table = wrapper.querySelector('table');
  return table !== null && table.scrollWidth > wrapper.clientWidth + 1;
}

/** Pin the overlays to the visible area: they are children of the
    horizontally scrolling wrapper, so they would otherwise travel with the
    table content. Translating them back by scrollLeft keeps them docked to
    the scrollport's right edge. Pure transform — no layout. Also maintains
    the at-end marker (fades the gradient out once the user reaches the
    rightmost scroll position, where there is no more content to hint at). */
export function pinTableWideToggle(wrapper: HTMLElement): void {
  const offset = `translateX(${wrapper.scrollLeft}px)`;
  const fade = findFade(wrapper);
  if (fade) fade.style.transform = offset;
  const button = findToggle(wrapper);
  if (button) button.style.transform = offset;
  const atEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 2;
  wrapper.classList.toggle(TABLE_AT_END_CLASS, atEnd);
}

/** Inject the widen/restore chip (+ edge fade) into a `.table-node-wrapper`.
    Idempotent: returns the existing button when already injected, and null
    outside the chat-message host context. */
export function ensureTableWideToggle(
  wrapper: HTMLElement,
  labels: TableWideToggleLabels,
): HTMLButtonElement | null {
  const existing = findToggle(wrapper);
  if (existing) return existing;
  if (!isTableWideHost(wrapper)) return null;

  const fade = document.createElement('div');
  fade.className = TABLE_FADE_CLASS;
  fade.setAttribute('aria-hidden', 'true');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = TABLE_TOGGLE_CLASS;
  button.innerHTML = WIDEN_ICON;
  button.setAttribute('aria-label', labels.widen);
  button.title = labels.widen;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleTableWide(wrapper, labels);
  });

  wrapper.appendChild(fade);
  wrapper.appendChild(button);
  wrapper.addEventListener('scroll', () => pinTableWideToggle(wrapper), { passive: true });
  updateTableWideToggle(wrapper);
  return button;
}

/** Toggle the breakout state on the wrapper, swap the chip icon/label, and
    notify ancestors (ConversationPane's TOC occlusion hit test) that the
    table geometry changed without a scroll. */
export function toggleTableWide(wrapper: HTMLElement, labels: TableWideToggleLabels): void {
  const wide = wrapper.classList.toggle(TABLE_WIDE_CLASS);
  const button = findToggle(wrapper);
  if (button) {
    button.innerHTML = wide ? RESTORE_ICON : WIDEN_ICON;
    const label = wide ? labels.restore : labels.widen;
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  updateTableWideToggle(wrapper);
  wrapper.dispatchEvent(new CustomEvent(TABLE_LAYOUT_EVENT, { bubbles: true }));
}

/** Visibility rules. Chip: shown when the table overflows the wrapper (it is
    clipped/scrollable) or is already widened (so the user can restore it);
    CSS further gates actual display on hover/focus-within/wide and on the
    ≥760px container. Fade: shown only while the table actually overflows —
    a widened table that now fits has nothing more to hint at. */
export function updateTableWideToggle(wrapper: HTMLElement): void {
  const button = findToggle(wrapper);
  if (!button) return;
  const overflows = tableOverflows(wrapper);
  const wide = wrapper.classList.contains(TABLE_WIDE_CLASS);
  button.classList.toggle(TABLE_TOGGLE_SHOW_CLASS, overflows || wide);
  const fade = findFade(wrapper);
  if (fade) fade.classList.toggle(TABLE_TOGGLE_SHOW_CLASS, overflows);
  alignTableWideToggle(wrapper);
  pinTableWideToggle(wrapper);
}
