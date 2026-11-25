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

function clampWindowStart(value: number, total: number, size: number): number {
  const maxStart = Math.max(0, total - size);
  return Math.min(Math.max(0, Math.floor(value)), maxStart);
}

export class StableWindow {
  private start = 0;

  constructor(initialStart = 0) {
    this.start = Math.max(0, Math.floor(initialStart));
  }

  reset(start = 0): void {
    this.start = Math.max(0, Math.floor(start));
  }

  get offset(): number {
    return this.start;
  }

  ensureVisible(index: number, total: number, pageSize: number): void {
    const safeTotal = Math.max(0, Math.floor(total));
    if (safeTotal === 0) {
      this.start = 0;
      return;
    }
    const size = Math.max(1, Math.floor(pageSize));
    const safeIndex = Math.min(Math.max(0, Math.floor(index)), safeTotal - 1);
    let next = clampWindowStart(this.start, safeTotal, size);
    if (safeIndex < next) next = safeIndex;
    else if (safeIndex >= next + size) next = safeIndex - size + 1;
    this.start = clampWindowStart(next, safeTotal, size);
  }

  scrollBy(delta: number, total: number, pageSize: number): boolean {
    const safeTotal = Math.max(0, Math.floor(total));
    const size = Math.max(1, Math.floor(pageSize));
    const before = clampWindowStart(this.start, safeTotal, size);
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    const next = clampWindowStart(before + step, safeTotal, size);
    this.start = next;
    return next !== before;
  }

  range(total: number, pageSize: number): { readonly start: number; readonly end: number } {
    const safeTotal = Math.max(0, Math.floor(total));
    const size = Math.max(1, Math.floor(pageSize));
    const start = clampWindowStart(this.start, safeTotal, size);
    this.start = start;
    return { start, end: Math.min(start + size, safeTotal) };
  }
}
