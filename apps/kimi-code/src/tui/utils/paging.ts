/**
 * Pure paging math shared by list pickers (ChoicePicker, ModelSelector).
 *
 * The component owns a single `selectedIndex` into its (already filtered)
 * item list; the page is derived from it, so ↑↓ moves the cursor smoothly
 * across page boundaries while the view still shows an explicit page number.
 */

export interface PageView {
  /** Zero-based index of the page containing `selectedIndex`. */
  readonly page: number;
  /** Total number of pages; always at least 1, even for an empty list. */
  readonly pageCount: number;
  /** Inclusive slice start of the current page. */
  readonly start: number;
  /** Exclusive slice end of the current page (clamped to `total`). */
  readonly end: number;
}

export function pageView(total: number, selectedIndex: number, pageSize: number): PageView {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safeIndex = total <= 0 ? 0 : Math.min(Math.max(0, selectedIndex), total - 1);
  const page = Math.min(Math.floor(safeIndex / size), pageCount - 1);
  const start = page * size;
  const end = Math.min(start + size, total);
  return { page, pageCount, start, end };
}
