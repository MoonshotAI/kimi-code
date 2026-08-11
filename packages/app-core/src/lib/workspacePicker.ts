export const MAX_VISIBLE_WORKSPACES = 5;

export function getVisibleWorkspaces<T extends { id: string }>(
  workspaces: T[],
  activeId: string | null | undefined,
  expanded: boolean,
  max = MAX_VISIBLE_WORKSPACES,
): T[] {
  if (expanded || workspaces.length <= max) return workspaces;

  const visible = workspaces.slice(0, max);
  if (activeId && !visible.some((w) => w.id === activeId)) {
    const active = workspaces.find((w) => w.id === activeId);
    if (active) visible[max - 1] = active;
  }
  return visible;
}
