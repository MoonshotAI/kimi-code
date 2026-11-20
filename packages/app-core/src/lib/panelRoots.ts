import { workspaceRootKey } from './rootKey';

export interface PanelRoots {
  readonly root: string;
  readonly roots: readonly string[];
}

export function panelRoots(
  session: { readonly cwd: string } | undefined,
  workspace: { readonly root: string; readonly additionalDirs: readonly string[] },
): PanelRoots {
  const root = session === undefined || session.cwd === '' ? workspace.root : session.cwd;
  const registered = [workspace.root, ...workspace.additionalDirs];
  const rootKey = workspaceRootKey(root);
  const reachable = registered.some((dir) => workspaceRootKey(dir) === rootKey) ? registered : workspace.additionalDirs;
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const dir of [root, ...reachable]) {
    const key = workspaceRootKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(dir);
  }
  return { root, roots };
}
