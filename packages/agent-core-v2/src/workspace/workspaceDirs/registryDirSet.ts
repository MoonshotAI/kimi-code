import { sameDir } from '#/_base/utils/workdir-slug';
import type { Workspace } from '#/app/workspace/workspace';

export interface RegistryDirSetInput {
  readonly project?: Workspace;
  readonly others: readonly Workspace[];
  readonly cwd: string;
  readonly local: boolean;
  readonly followsPrimary: boolean;
}

export interface RegistryDirSet {
  readonly registryDirs: readonly string[];
  readonly primaryByWorkspace: Readonly<Record<string, string>>;
}

export function registryDirSet(input: RegistryDirSetInput): RegistryDirSet {
  const registryDirs: string[] = [];
  const primaryByWorkspace: Record<string, string> = {};
  const add = (dirs: readonly string[], except: string): void => {
    for (const dir of dirs) {
      if (sameDir(dir, except) || registryDirs.some((kept) => sameDir(kept, dir))) continue;
      registryDirs.push(dir);
    }
  };
  const { project, cwd } = input;
  if (project !== undefined) {
    const registered = [project.root, ...project.additionalDirs];
    if (input.local && input.followsPrimary) {
      primaryByWorkspace[project.id] = project.root;
      add(project.additionalDirs, project.root);
    } else if (registered.some((dir) => sameDir(dir, cwd))) {
      primaryByWorkspace[project.id] = project.root;
      add(registered, cwd);
    } else if (input.local) {
      add(project.additionalDirs, cwd);
    }
  }
  for (const other of input.others) {
    if (other.id === project?.id || other.kind !== 'implicit') continue;
    const registered = [other.root, ...other.additionalDirs];
    if (!registered.some((dir) => sameDir(dir, cwd))) continue;
    primaryByWorkspace[other.id] = other.root;
    add(registered, cwd);
  }
  return { registryDirs, primaryByWorkspace };
}
