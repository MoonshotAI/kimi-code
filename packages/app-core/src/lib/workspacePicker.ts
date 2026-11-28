import { pathSearchKey } from './searchHighlight';

export function filterWorkspaces<T extends { name: string; root: string; shortPath: string; hostId?: string }>(
  workspaces: readonly T[],
  query: string,
  hostText?: (hostId: string) => readonly string[],
): T[] {
  const normalized = pathSearchKey(query.trim());
  if (normalized === '') return [...workspaces];
  return workspaces.filter((workspace) => {
    const extra = workspace.hostId !== undefined && hostText ? hostText(workspace.hostId) : [];
    return [workspace.name, workspace.root, workspace.shortPath, ...extra].some((value) =>
      pathSearchKey(value).includes(normalized),
    );
  });
}
