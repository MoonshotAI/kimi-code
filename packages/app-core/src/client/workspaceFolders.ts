import { workspaceRootKey } from '../lib/rootKey';

export interface WorkspaceFolder {
  path: string;
  primary: boolean;
}

export function workspaceFolders(input: {
  root: string;
  additionalDirs?: readonly string[];
}): WorkspaceFolder[] {
  if (input.root.length === 0) return [];
  const folders = [{ path: input.root, primary: true }];
  const seen = new Set([workspaceRootKey(input.root)]);
  for (const path of input.additionalDirs ?? []) {
    const key = workspaceRootKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push({ path, primary: false });
  }
  return folders;
}
