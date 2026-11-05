import {
  IWorkspaceAliases,
  IWorkspaceService,
  type Scope,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';

export async function loadWorkspaceVisibility(core: Scope): Promise<{
  readonly workspaces: readonly Workspace[];
  readonly roots: ReadonlyMap<string, string>;
  readonly visibleWorkspaceIds: ReadonlySet<string>;
}> {
  return readVisibleWorkspaces(
    core.accessor.get(IWorkspaceService),
    core.accessor.get(IWorkspaceAliases),
  );
}

export async function readVisibleWorkspaces(
  workspaceService: IWorkspaceService,
  aliases: IWorkspaceAliases,
): Promise<{
  readonly workspaces: readonly Workspace[];
  readonly roots: ReadonlyMap<string, string>;
  readonly visibleWorkspaceIds: ReadonlySet<string>;
}> {
  const workspaces = await workspaceService.list();
  const visibleWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const aliasIds = await Promise.all(
    workspaces.map((workspace) => aliases.resolveAliasIds(workspace.id)),
  );
  for (const id of aliasIds.flat()) visibleWorkspaceIds.add(id);
  return {
    workspaces,
    roots: new Map(workspaces.map((workspace) => [workspace.id, workspace.root])),
    visibleWorkspaceIds,
  };
}
