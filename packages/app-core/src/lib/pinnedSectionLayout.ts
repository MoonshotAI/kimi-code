// packages/app-core/src/lib/pinnedSectionLayout.ts
// Layout rules for the sidebar's pinned section height split (the draggable
// handle between the pinned rows and the session list below, rendered by
// PinnedSessionList). Pure and Vue-free so the threshold/clamp rules stay
// unit-testable; the component owns the DOM measuring and pointer wiring
// (via app-client's useResizable).

/**
 * Height of one pinned row at the default font scale (px): the flat-style
 * two-line SessionRow — 8px padding + ~16px title line + 4px gap + ~14px
 * directory line + 8px padding. Rows are font-driven, so the real height
 * tracks the font-scale setting; this estimate only feeds the drag bounds,
 * never exact layout, so a scale shift costs at most a fractional row at the
 * bounds.
 */
export const PINNED_ROW_HEIGHT = 50;

/**
 * Compact-section threshold, in rows. While the pinned content fits in this
 * many rows the section keeps its natural content height and NO resize handle
 * renders (the historical short-list behaviour); with more rows than this the
 * handle appears and the rows container is capped by the draggable height.
 */
export const PINNED_HANDLE_ROW_THRESHOLD = 3;

/**
 * Drag lower bound for the pinned rows container (px) at the DEFAULT font
 * scale: the handle can never shrink the section below two full rows.
 */
export const PINNED_ROWS_MIN_HEIGHT = PINNED_ROW_HEIGHT * 2;

/**
 * Drag lower bound (px) at the CURRENT font scale: the combined height of
 * the first TWO rendered rows, so the "never less than two complete records"
 * promise survives the font-size setting (at XL a two-line pinned row is
 * ~61px and the fixed default floor would barely show one and a half) and
 * taller later rows (the second row can carry approval/question badges or a
 * PR pill). Falls back to the default-scale constant when no row has been
 * measured; with a single measured row the floor is that row alone.
 */
export function pinnedRowsMinHeight(firstRowHeights?: readonly (number | null)[] | null): number {
  const valid = (firstRowHeights ?? [])
    .filter((h): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0)
    .slice(0, 2);
  if (valid.length === 0) return PINNED_ROWS_MIN_HEIGHT;
  return Math.round(valid.reduce((sum, h) => sum + h, 0));
}

/** Sanitize a caller-computed drag floor (pinnedRowsMinHeight's output). */
function resolveMinHeight(minHeight?: number | null): number {
  if (minHeight === null || minHeight === undefined || !Number.isFinite(minHeight) || minHeight <= 0) {
    return PINNED_ROWS_MIN_HEIGHT;
  }
  return Math.round(minHeight);
}

/**
 * Minimum height the session list below the pinned section always keeps (px)
 * at the DEFAULT font scale: ~3 single-line session rows (32px each). The
 * drag cap never lets the pinned rows push the list below this.
 */
export const SESSIONS_LIST_MIN_HEIGHT = 96;

/**
 * One session-list row as the component measured it. Rows inside a COLLAPSED
 * workspace group stay mounted in a zero-height clip container
 * (WorkspaceGroup's .group-sessions.collapsed), so the component marks them
 * `visible: false` and they must not count as the "third row".
 * `viewportBottom` is the row's bottom edge in viewport coordinates
 * (getBoundingClientRect().bottom) — measureSessionsListRows folds the scroll
 * offset back in, so callers never adjust it themselves.
 */
export interface SessionListRowMeasure {
  visible: boolean;
  height: number;
  viewportBottom: number;
}

/**
 * Rendered metrics of the session list, distilled from the measured rows:
 * - `firstRowHeight`: the first VISIBLE row's height — null when no visible
 *   row renders (empty states), so the caller can keep its last good value;
 * - `spanToThirdRow`: the vertical span from the list's content top to the
 *   THIRD visible row's bottom edge, in the list's CONTENT coordinate system —
 *   the viewport-coordinates delta plus the scroller's scrollTop, so the span
 *   does not shrink as the list scrolls (grouped mode's workspace headers are
 *   naturally included). Null with fewer than three visible rows;
 *   sessionsListMinHeight then falls back to the uniform-row estimate.
 */
export function measureSessionsListRows(
  rows: readonly SessionListRowMeasure[],
  listViewportTop: number,
  listScrollTop: number,
): { firstRowHeight: number | null; spanToThirdRow: number | null } {
  const visible = rows.filter((row) => row.visible);
  const first = visible[0];
  const third = visible[2];
  return {
    firstRowHeight: first ? first.height : null,
    spanToThirdRow: third ? third.viewportBottom - listViewportTop + listScrollTop : null,
  };
}

/**
 * Session-list keep (px) at the CURRENT font scale / display mode. Tiers,
 * best first:
 * 1. `spanToThirdRow` — the measured vertical span from the list's top to
 *    the THIRD visible session row's bottom edge. Only a real span includes
 *    grouped mode's workspace headers (three sessions spread across groups
 *    are much taller than 3 × a bare row).
 * 2. Fewer than three rows rendered: three uniform rendered rows.
 * Both add the container's measured bottom padding (`sessionsPaddingY` —
 * the component reads it off .sessions with getComputedStyle; no pixel value
 * is duplicated here, so a spacing-scale retune can't fork the two). Falls
 * back to the default-scale constant unless the padding and at least one
 * height input are measured and sane.
 */
export function sessionsListMinHeight(
  spanToThirdRow?: number | null,
  sessionsPaddingY?: number | null,
  sessionRowHeight?: number | null,
): number {
  const positive = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined && Number.isFinite(v) && v > 0;
  const nonNegative = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined && Number.isFinite(v) && v >= 0;
  if (!nonNegative(sessionsPaddingY)) return SESSIONS_LIST_MIN_HEIGHT;
  if (positive(spanToThirdRow)) {
    return Math.round(spanToThirdRow) + Math.round(sessionsPaddingY);
  }
  if (positive(sessionRowHeight)) {
    return Math.round(sessionRowHeight) * 3 + Math.round(sessionsPaddingY);
  }
  return SESSIONS_LIST_MIN_HEIGHT;
}

/** True when the pinned section is tall enough to offer the resize handle. */
export function pinnedSectionResizable(pinnedCount: number): boolean {
  return pinnedCount > PINNED_HANDLE_ROW_THRESHOLD;
}

/**
 * Default rows-container cap (px) — mirrors the section's historical 40vh
 * max-height, so an upgraded user sees the same split until they drag.
 */
export function pinnedRowsDefaultHeight(viewportHeight: number): number {
  return Math.round(viewportHeight * 0.4);
}

/** Sanitize a caller-computed session-list keep (sessionsListMinHeight's output). */
function resolveSessionsKeep(sessionsKeep?: number | null): number {
  if (sessionsKeep === null || sessionsKeep === undefined || !Number.isFinite(sessionsKeep) || sessionsKeep <= 0) {
    return SESSIONS_LIST_MIN_HEIGHT;
  }
  return Math.round(sessionsKeep);
}

/**
 * Drag upper bound (px). Two caps, whichever binds first:
 * - viewport: 60% of the window height (the bottom terminal panel's
 *   precedent);
 * - budget: `splitBudget` — the px currently shared by the pinned rows and
 *   the session list (their combined rendered height, an invariant of the
 *   split: growing one shrinks the other by the same amount) — minus the
 *   list's keep (`sessionsKeep`: three rendered session rows plus the list's
 *   bottom padding at the current font scale; the default-scale constant
 *   when unmeasured). On short windows the sidebar's fixed chrome makes this
 *   bind well before 60vh, so the list is never squeezed away.
 * `splitBudget` is undefined before the component measures the DOM (or when
 * the section is folded); the plain viewport cap governs then. The result is
 * floored at `minHeight` — the drag floor currently in effect
 * (pinnedRowsMinHeight at the rendered row height; the default-scale
 * constant when unmeasured) — so the bounds can never invert on any
 * viewport/font-scale combination (a short window at XL otherwise presses
 * the cap below the floor and the second record gets cut off).
 */
export function pinnedRowsMaxHeight(
  viewportHeight: number,
  splitBudget?: number,
  minHeight?: number | null,
  sessionsKeep?: number | null,
): number {
  const floor = resolveMinHeight(minHeight);
  const keep = resolveSessionsKeep(sessionsKeep);
  const viewportCap = Math.max(floor, Math.round(viewportHeight * 0.6));
  if (splitBudget === undefined || !Number.isFinite(splitBudget)) return viewportCap;
  const budgetCap = Math.round(splitBudget) - keep;
  return Math.max(floor, Math.min(viewportCap, budgetCap));
}

/**
 * Ceiling for one resize gesture / keyboard step (px): the layout cap
 * (pinnedRowsMaxHeight) narrowed to the content's NATURAL height. A position
 * past the content renders nothing — the rows box is max-height-capped, so
 * growing the cap beyond the content would leave the separator visibly put
 * while the persisted value and aria-valuenow claim it moved. Shrinking is
 * always allowed (the content then becomes scrollable and growing back
 * within the content range is meaningful). `contentHeight` is null before
 * the component measures the DOM; the plain layout cap governs then. Floored
 * at `minHeight` — the same dynamic drag floor as pinnedRowsMaxHeight — so
 * the bounds can never invert.
 */
export function pinnedRowsResizeCeiling(
  layoutCap: number,
  contentHeight?: number | null,
  minHeight?: number | null,
): number {
  if (contentHeight === null || contentHeight === undefined || !Number.isFinite(contentHeight)) {
    return layoutCap;
  }
  return Math.max(resolveMinHeight(minHeight), Math.min(layoutCap, Math.round(contentHeight)));
}

/**
 * Target of one keyboard step (px): base + step clamped to BOTH bounds
 * (`minHeight` floor and `ceiling`). Compare the result with `base` BEFORE
 * committing — equality means the key press is a true no-op (already at the
 * bound), and the caller must neither mark the value as user-chosen nor
 * persist anything.
 */
export function pinnedRowsKeyboardTarget(
  base: number,
  step: number,
  ceiling: number,
  minHeight: number,
): number {
  return Math.max(Math.round(minHeight), Math.min(Math.round(base + step), Math.round(ceiling)));
}

/**
 * True when a resize gesture ends without effective displacement: no live
 * frame ever ran (a plain click) or the final value landed back on the
 * gesture's start. The caller restores the pre-gesture state then — and the
 * gesture must not count as a user adjustment.
 */
export function isNoopGesture(startHeight: number | null, liveHeight: number | null): boolean {
  return liveHeight === null || liveHeight === startHeight;
}
