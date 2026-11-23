import type { ContextItemSummary } from '../protocol/rest-context';

export function selectContextItems(
  allNonToolItems: ContextItemSummary[],
  toolItems: ContextItemSummary[],
  filterRoles: readonly string[],
): { items: ContextItemSummary[]; tools: ContextItemSummary[] } {
  const selectedRoles = new Set(filterRoles);
  if (filterRoles.length === 0) return { items: allNonToolItems, tools: toolItems };
  return {
    items: [
      ...allNonToolItems.filter(
        (item) => item.role === 'system' && selectedRoles.has(item.role),
      ),
      ...(selectedRoles.has('definition') ? toolItems : []),
      ...allNonToolItems.filter(
        (item) => item.role !== 'system' && selectedRoles.has(item.role),
      ),
    ],
    tools: selectedRoles.has('definition') ? toolItems : [],
  };
}
