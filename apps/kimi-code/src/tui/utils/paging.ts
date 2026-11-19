export interface PageView {
  readonly page: number;
  readonly pageCount: number;
  readonly start: number;
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
