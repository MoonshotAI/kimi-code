export function menuNavigationIndex(key: string, shiftKey: boolean, index: number, count: number): number | null {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(key)) return null;
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const direction = key === 'ArrowUp' || (key === 'Tab' && shiftKey) ? -1 : 1;
  if (index < 0) return direction === -1 ? count - 1 : 0;
  return (index + direction + count) % count;
}
