export function filterWorkspaces<T extends { name: string; root: string; shortPath: string; deviceId?: string }>(
  workspaces: readonly T[],
  query: string,
  deviceText?: (deviceId: string) => readonly string[],
): T[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return [...workspaces];
  return workspaces.filter((workspace) => {
    const extra = workspace.deviceId !== undefined && deviceText ? deviceText(workspace.deviceId) : [];
    return [workspace.name, workspace.root, workspace.shortPath, ...extra].some((value) =>
      value.toLowerCase().includes(normalized),
    );
  });
}
