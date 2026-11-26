import { join, relative } from 'pathe';

import { isAncestorOrSelf, sameDir, toAbsoluteDir, type AbsoluteDir } from '#/_base/utils/workdir-slug';
import { locateCheckout } from '#/app/git/workTree';
import { realpathExistingPrefix } from '#/environment/environment';
import { ENVIRONMENT_PATHS } from '#/environment/environmentDefaults';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { repositoryOf } from './implicitProject';

export interface WorkDirPorts {
  readonly fs: IHostFileSystem;
  readonly homeDirs: readonly string[] | undefined;
  readonly pathClass?: PathClass;
}

interface DirPlace {
  readonly dir: AbsoluteDir;
  readonly checkout: AbsoluteDir;
  readonly repository: AbsoluteDir;
}

const HOST_PATH_CLASS: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

export async function projectDirAt(projectRoot: string, dir: string, ports: WorkDirPorts): Promise<string | undefined> {
  if (dir === projectRoot) return projectRoot;
  const [root, target] = await Promise.all([placeOf(projectRoot, ports), placeOf(dir, ports)]);
  if (root === undefined || target === undefined) return undefined;
  const counterpart = counterpartOf(root, target);
  if (counterpart === undefined || !isAncestorOrSelf(counterpart, target.dir)) return undefined;
  return sameDir(counterpart, root.dir) ? projectRoot : counterpart;
}

function counterpartOf(root: DirPlace, target: DirPlace): string | undefined {
  if (sameDir(target.repository, root.dir)) return target.checkout;
  return sameDir(target.repository, root.repository) ? join(target.checkout, relative(root.checkout, root.dir)) : undefined;
}

async function placeOf(dir: string, ports: WorkDirPorts): Promise<DirPlace | undefined> {
  const path = ENVIRONMENT_PATHS[ports.pathClass ?? HOST_PATH_CLASS];
  if (!path.isAbsolute(dir)) return undefined;
  const real = toAbsoluteDir(await realpathExistingPrefix(ports.fs, path, dir, () => true));
  if (real === undefined) return undefined;
  const repository = repositoryOf(await locateCheckout(ports.fs, real), ports.homeDirs);
  return repository === undefined
    ? { dir: real, checkout: real, repository: real }
    : { dir: real, checkout: repository.checkoutRoot, repository: repository.canonicalMainDir };
}
