import {
  encodeWorkDirKey,
  isAncestorOrSelf,
  isWorkDirKey,
  normalizeDir,
  sameDir,
  toAbsoluteDir,
  type AbsoluteDir,
} from '#/_base/utils/workdir-slug';
import type { CheckoutLocation, GroupedCheckout } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { Project } from './project';

export interface ImplicitDecision {
  readonly id: string;
  readonly root: string;
  readonly project?: Project;
}

export interface ImplicitResolutionPorts {
  readonly occupied: (project: Project) => Promise<boolean>;
  readonly locate: (dir: AbsoluteDir) => Promise<CheckoutLocation>;
  readonly homeDirs: readonly string[] | undefined;
}

export async function decideImplicitProject(
  dir: string,
  workspaces: readonly Project[],
  ports: ImplicitResolutionPorts,
): Promise<ImplicitDecision> {
  const implicit = workspaces.filter((workspace) => isWorkDirKey(workspace.id));
  const own = projectWithId(implicit, encodeWorkDirKey(dir)) ?? projectRootedAt(implicit, dir);
  if (own !== undefined && (await ports.occupied(own))) return reuse(own);
  const absolute = toAbsoluteDir(dir);
  const location = absolute === undefined ? undefined : await ports.locate(absolute);
  const repository = repositoryOf(location, ports.homeDirs);
  const grouped = repository === undefined ? undefined : repositoryDecision(repository, implicit);
  return grouped ?? (own === undefined ? { id: encodeWorkDirKey(dir), root: normalizeDir(dir) } : reuse(own));
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

function reuse(project: Project): ImplicitDecision {
  return { id: project.id, root: project.root, project };
}

function repositoryDecision(
  location: GroupedCheckout,
  implicit: readonly Project[],
): ImplicitDecision | undefined {
  const project = projectRootedAt(implicit, location.mainDir) ?? projectRootedAt(implicit, location.canonicalMainDir);
  if (project !== undefined) return reuse(project);
  const id = encodeWorkDirKey(location.mainDir);
  const movedAway = projectWithId(implicit, id) !== undefined;
  return movedAway ? undefined : { id, root: location.mainDir };
}

function projectWithId(implicit: readonly Project[], id: string): Project | undefined {
  return implicit.find((project) => project.id === id);
}

function projectRootedAt(implicit: readonly Project[], dir: string): Project | undefined {
  const rooted = implicit.filter((project) => sameDir(project.root, dir));
  return rooted.find((project) => project.id === encodeWorkDirKey(project.root)) ?? rooted[0];
}
