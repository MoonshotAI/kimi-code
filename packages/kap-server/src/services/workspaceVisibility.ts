import {
  IWorkspaceAliases,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

export async function loadWorkspaceVisibility(core: Scope): Promise<{
  readonly roots: ReadonlyMap<string, string>;
  readonly visibleWorkspaceIds: ReadonlySet<string>;
}> {
  const workspaces = await core.accessor.get(IWorkspaceService).list();
  const visibleWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const aliases = core.accessor.get(IWorkspaceAliases);
  const aliasIds = await Promise.all(
    workspaces.map((workspace) => aliases.resolveAliasIds(workspace.id)),
  );
  for (const id of aliasIds.flat()) visibleWorkspaceIds.add(id);
  return {
    roots: new Map(workspaces.map((workspace) => [workspace.id, workspace.root])),
    visibleWorkspaceIds,
  };
}
