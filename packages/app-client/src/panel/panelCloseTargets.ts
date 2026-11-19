export type PanelCloseAction = 'close' | 'others' | 'right' | 'all';

export function panelCloseTargets<T extends { id: string }>(tabs: readonly T[], action: PanelCloseAction, id?: string): T[] {
  if (action === 'all') return [...tabs];
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return [];
  if (action === 'close') return tabs.slice(index, index + 1);
  if (action === 'right') return tabs.slice(index + 1);
  return tabs.filter(tab => tab.id !== id);
}
