export function nextBrowserMenuIndex(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

export function revealBrowserMenuSelection(menu: HTMLElement | undefined): void {
  menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
