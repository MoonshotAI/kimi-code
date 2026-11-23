import {
  encodeWorkDirKey,
  isAncestorOrSelf,
  isWorkDirKey,
  sameDir,
  toAbsoluteDir,
  type AbsoluteDir,
} from '#/_base/utils/workdir-slug';
import type { CheckoutLocation, GroupedCheckout } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { Workspace } from './workspace';

export interface ImplicitDecision {
  readonly id: string;
  readonly root: string;
  readonly project?: Workspace;
}

export interface ImplicitResolutionPorts {
  readonly occupied: (project: Workspace) => Promise<boolean>;
  readonly locate: (dir: AbsoluteDir) => Promise<CheckoutLocation>;
  readonly homeDirs: readonly string[] | undefined;
}

export async function decideImplicitProject(
  dir: string,
  workspaces: readonly Workspace[],
  ports: ImplicitResolutionPorts,
): Promise<ImplicitDecision> {
  const implicit = workspaces.filter((workspace) => isWorkDirKey(workspace.id));
  const own = projectWithId(implicit, encodeWorkDirKey(dir)) ?? projectRootedAt(implicit, dir);
  if (own !== undefined && (await ports.occupied(own))) return reuse(own);
  const absolute = toAbsoluteDir(dir);
  const location = absolute === undefined ? undefined : await ports.locate(absolute);
  const repository = repositoryOf(location, ports.homeDirs);
  const grouped = repository === undefined ? undefined : repositoryDecision(repository, implicit);
  return grouped ?? (own === undefined ? { id: encodeWorkDirKey(dir), root: dir } : reuse(own));
}

export function repositoryOf(
  location: CheckoutLocation | undefined,
  homeDirs: readonly string[] | undefined,
): GroupedCheckout | undefined {
  if (location?.kind !== 'grouped' || homeDirs === undefined) return undefined;
  const coversHome = [location.mainDir, location.canonicalMainDir].some((mainDir) =>
    homeDirs.some((home) => isAncestorOrSelf(mainDir, home)),
  );
  return coversHome ? undefined : location;
}

export async function isNonDirectory(fs: IHostFileSystem, dir: string): Promise<boolean> {
  try {
    if ((await fs.stat(dir)).isDirectory) return false;
    return !(await fs.stat(await fs.realpath(dir))).isDirectory;
  } catch {
    return false;
  }
}

function reuse(project: Workspace): ImplicitDecision {
  return { id: project.id, root: project.root, project };
}

function repositoryDecision(
  location: GroupedCheckout,
  implicit: readonly Workspace[],
): ImplicitDecision | undefined {
  const project = projectRootedAt(implicit, location.mainDir) ?? projectRootedAt(implicit, location.canonicalMainDir);
  if (project !== undefined) return reuse(project);
  const id = encodeWorkDirKey(location.mainDir);
  const movedAway = projectWithId(implicit, id) !== undefined;
  return movedAway ? undefined : { id, root: location.mainDir };
}

function projectWithId(implicit: readonly Workspace[], id: string): Workspace | undefined {
  return implicit.find((project) => project.id === id);
}

function projectRootedAt(implicit: readonly Workspace[], dir: string): Workspace | undefined {
  const rooted = implicit.filter((project) => sameDir(project.root, dir));
  return rooted.find((project) => project.id === encodeWorkDirKey(project.root)) ?? rooted[0];
}
