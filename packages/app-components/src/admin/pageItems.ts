// Page-number folding for the session admin pager: at most 7 slots,
// current page kept within two of the edges it sits between.
//   total <= 7     1 2 3 4 5 6 7
//   cur <= 4       1 2 3 4 5 … N
//   cur >= N - 3   1 … N-4 N-3 N-2 N-1 N
//   otherwise      1 … cur-1 cur cur+1 … N

export type PageItem = number | '…';

export function pageItems(cur: number, total: number): PageItem[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (cur <= 4) return [1, 2, 3, 4, 5, '…', total];
  if (cur >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total];
  return [1, '…', cur - 1, cur, cur + 1, '…', total];
}
