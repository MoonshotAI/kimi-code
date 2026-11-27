
export interface OpenGroupLike {
  readonly sessions: readonly unknown[];
  readonly workspace: { readonly id: string };
}

export function visibleOpenGroups<T extends OpenGroupLike>(
  groups: T[],
  activeWorkspaceId: string | null | undefined,
  statusTabs: boolean,
): T[] {
  if (!statusTabs) return groups;
  return groups.filter(
    (g) => g.sessions.length > 0 || g.workspace.id === activeWorkspaceId,
  );
}
