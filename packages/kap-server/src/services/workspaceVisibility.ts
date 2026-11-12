import {
  IWorkspaceAliases,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

export async function loadWorkspaceVisibility(core: Scope): Promise<{
  readonly roots: ReadonlyMap<string, string>;
  readonly registeredWorkspaceIds: ReadonlySet<string>;
  readonly visibleWorkspaceIds: ReadonlySet<string>;
}> {
  const workspaces = await core.accessor.get(IWorkspaceService).list();
  const registeredWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const visibleWorkspaceIds = new Set(registeredWorkspaceIds);
  const aliases = core.accessor.get(IWorkspaceAliases);
  const aliasIds = await Promise.all(
    workspaces.map((workspace) => aliases.resolveAliasIds(workspace.id)),
  );
  const roots = new Map(workspaces.map((workspace) => [workspace.id, workspace.root]));
  for (const [index, ids] of aliasIds.entries()) {
    const root = workspaces[index]!.root;
    for (const id of ids) {
      visibleWorkspaceIds.add(id);
      if (!roots.has(id)) roots.set(id, root);
    }
  }
  return {
    roots,
    registeredWorkspaceIds,
    visibleWorkspaceIds,
  };
}
