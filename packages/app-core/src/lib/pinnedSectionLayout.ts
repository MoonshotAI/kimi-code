
export const PINNED_ROW_HEIGHT = 50;

export const PINNED_HANDLE_ROW_THRESHOLD = 3;

export const PINNED_ROWS_MIN_HEIGHT = PINNED_ROW_HEIGHT * 2;

export function pinnedRowsMinHeight(firstRowHeights?: readonly (number | null)[] | null): number {
  const valid = (firstRowHeights ?? [])
    .filter((h): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0)
    .slice(0, 2);
  if (valid.length === 0) return PINNED_ROWS_MIN_HEIGHT;
  return Math.round(valid.reduce((sum, h) => sum + h, 0));
}

function resolveMinHeight(minHeight?: number | null): number {
  if (minHeight === null || minHeight === undefined || !Number.isFinite(minHeight) || minHeight <= 0) {
    return PINNED_ROWS_MIN_HEIGHT;
  }
  return Math.round(minHeight);
}

export const SESSIONS_LIST_MIN_HEIGHT = 96;

export interface SessionListRowMeasure {
  visible: boolean;
  height: number;
  viewportBottom: number;
}

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

export function pinnedSectionResizable(pinnedCount: number): boolean {
  return pinnedCount > PINNED_HANDLE_ROW_THRESHOLD;
}

export function pinnedRowsDefaultHeight(viewportHeight: number): number {
  return Math.round(viewportHeight * 0.4);
}

function resolveSessionsKeep(sessionsKeep?: number | null): number {
  if (sessionsKeep === null || sessionsKeep === undefined || !Number.isFinite(sessionsKeep) || sessionsKeep <= 0) {
    return SESSIONS_LIST_MIN_HEIGHT;
  }
  return Math.round(sessionsKeep);
}

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

export function pinnedRowsKeyboardTarget(
  base: number,
  step: number,
  ceiling: number,
  minHeight: number,
): number {
  return Math.max(Math.round(minHeight), Math.min(Math.round(base + step), Math.round(ceiling)));
}

export function isNoopGesture(startHeight: number | null, liveHeight: number | null): boolean {
  return liveHeight === null || liveHeight === startHeight;
}
