import {
  IWorkspaceAliases,
  IWorkspaceService,
  IWorkspaceSessions,
  type Scope,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';

export async function loadWorkspaceVisibility(core: Scope): Promise<{
  readonly workspaces: readonly Workspace[];
  readonly roots: ReadonlyMap<string, string>;
  readonly visibleWorkspaceIds: ReadonlySet<string>;
  readonly sessionCounts: ReadonlyMap<string, number>;
}> {
  const registered = await core.accessor.get(IWorkspaceService).list();
  const sessionCounts = new Map<string, number>();
  const visible = await Promise.all(
    registered.map(async (workspace) => {
      const sessionCount = await core.accessor.get(IWorkspaceSessions).count(workspace.id);
      sessionCounts.set(workspace.id, sessionCount);
      return workspace.kind === 'managed' || sessionCount > 0 ? workspace : undefined;
    }),
  );
  const workspaces = visible.filter((workspace): workspace is Workspace => workspace !== undefined);
  const visibleWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const aliases = core.accessor.get(IWorkspaceAliases);
  const aliasIds = await Promise.all(
    workspaces.map((workspace) => aliases.resolveAliasIds(workspace.id)),
  );
  for (const id of aliasIds.flat()) visibleWorkspaceIds.add(id);
  return {
    workspaces,
    roots: new Map(workspaces.map((workspace) => [workspace.id, workspace.root])),
    visibleWorkspaceIds,
    sessionCounts,
  };
}
