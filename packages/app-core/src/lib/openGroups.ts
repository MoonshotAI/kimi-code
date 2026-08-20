// packages/app-core/src/lib/openGroups.ts
// Pure helper deciding which workspace groups the sidebar's open (进行中)
// list renders. Extracted from the two Sidebar.vue components so the rule is
// unit-testable without a Vue harness and stays identical on web + desktop.

export interface OpenGroupLike {
  readonly sessions: readonly unknown[];
  readonly workspace: { readonly id: string };
}

/**
 * Status-tabs view (`statusTabs` on): groups with no open sessions render
 * NOTHING — an empty folder is noise after a cleanup, and the 工作空间 tab is
 * the directory for creating sessions. Exception: the ACTIVE workspace's
 * group stays so the draft state keeps its "where I am" head fill.
 *
 * Legacy single-list view (`statusTabs` off): there is NO workspaces tab to
 * fall back on, so EVERY group renders — archiving a workspace's last session
 * must not make the workspace unreachable.
 */
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
