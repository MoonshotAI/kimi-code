export interface WorkspaceFolder {
  path: string;
  primary: boolean;
}

export function workspaceFolders(input: {
  root: string;
  additionalDirs?: readonly string[];
}): WorkspaceFolder[] {
  if (input.root.length === 0) return [];
  return [
    { path: input.root, primary: true },
    ...(input.additionalDirs ?? []).map((path) => ({ path, primary: false })),
  ];
}
