import {
  encodeWorkDirKey,
  isAncestorOrSelf,
  isWorkDirKey,
  sameDir,
  toAbsoluteDir,
  type AbsoluteDir,
  type ImplicitProjectId,
} from '#/_base/utils/workdir-slug';
import { locateCheckout, type CheckoutLocation, type GroupedCheckout } from '#/app/git/workTree';
import { realpathExistingPrefix } from '#/environment/environment';
import { ENVIRONMENT_PATHS } from '#/environment/environmentDefaults';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { Workspace } from './workspace';

export type ImplicitWorkspace = Workspace & { readonly kind: 'implicit' };

export interface ImplicitCatalog {
  readonly implicit: readonly ImplicitWorkspace[];
}

export interface ImplicitResolutionPorts {
  readonly occupied: (project: ImplicitWorkspace) => Promise<boolean>;
  readonly locate: (dir: AbsoluteDir) => Promise<CheckoutLocation>;
  readonly realpath: (dir: string) => Promise<string | undefined>;
  readonly homeDirs: readonly string[] | undefined;
}

export type ImplicitRule = 'sticky' | 'repo' | 'own';

export type ImplicitDecision =
  | { readonly kind: 'reuse'; readonly rule: ImplicitRule; readonly project: ImplicitWorkspace }
  | {
      readonly kind: 'create';
      readonly rule: Exclude<ImplicitRule, 'sticky'>;
      readonly id: ImplicitProjectId;
      readonly root: string;
    };

export interface ImplicitResolution {
  readonly decision: ImplicitDecision;
  readonly location?: CheckoutLocation;
}

export type ProjectScope = Pick<Workspace, 'root' | 'additionalDirs'>;

const HOST_PATH_CLASS: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

export function isImplicitWorkspace(workspace: Workspace): workspace is ImplicitWorkspace {
  return workspace.kind === 'implicit' && isWorkDirKey(workspace.id);
}

export function implicitCatalogOf(
  workspaces: readonly Workspace[],
  deletedIds: Iterable<string>,
): ImplicitCatalog {
  const deleted = new Set(deletedIds);
  return { implicit: workspaces.filter(isImplicitWorkspace).filter((workspace) => !deleted.has(workspace.id)) };
}

export async function decideImplicitProject(
  dir: string,
  catalog: ImplicitCatalog,
  ports: ImplicitResolutionPorts,
): Promise<ImplicitResolution> {
  const own = ownProjectOf(catalog.implicit, dir);
  if (own !== undefined && (await ports.occupied(own))) {
    return { decision: { kind: 'reuse', rule: 'sticky', project: own } };
  }
  const absolute = toAbsoluteDir(dir);
  const location = absolute === undefined ? undefined : await ports.locate(absolute);
  if (location?.kind === 'grouped' && ports.homeDirs !== undefined && !isHomeOrAncestor(location, ports.homeDirs)) {
    return { decision: await repositoryDecision(location, catalog.implicit, ports), location };
  }
  const decision: ImplicitDecision = own === undefined
    ? { kind: 'create', rule: 'own', id: encodeWorkDirKey(dir), root: dir }
    : { kind: 'reuse', rule: 'own', project: own };
  return location === undefined ? { decision } : { decision, location };
}

export function isHomeOrAncestor(location: GroupedCheckout, homeDirs: readonly string[]): boolean {
  return [location.mainDir, location.canonicalMainDir].some((mainDir) =>
    homeDirs.some((home) => isAncestorOrSelf(mainDir, home)),
  );
}

export function reviveRoot(bucketId: string, candidates: readonly (string | undefined)[]): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && encodeWorkDirKey(candidate) === bucketId);
}

export function reviveCandidates(
  workDir: string,
  realWorkDir: string | undefined,
  location: CheckoutLocation | undefined,
): readonly (string | undefined)[] {
  const grouped = location?.kind === 'grouped' ? [location.mainDir, location.canonicalMainDir] : [];
  return [workDir, realWorkDir, ...grouped];
}

export function projectScopeContains(
  realScope: ProjectScope,
  realDir: string,
  location: CheckoutLocation | undefined,
): boolean {
  if ([realScope.root, ...realScope.additionalDirs].some((scope) => isAncestorOrSelf(scope, realDir))) return true;
  return location !== undefined && groupsInto(location, realScope.root);
}

export function groupsInto(location: CheckoutLocation, realRoot: string): boolean {
  return location.kind === 'grouped' && sameDir(location.canonicalMainDir, realRoot);
}

export async function isInProjectScope(
  fs: IHostFileSystem,
  project: ProjectScope,
  dir: string,
  pathClass: PathClass = HOST_PATH_CLASS,
): Promise<boolean> {
  const absolute = toAbsoluteDir(dir);
  if (absolute === undefined) return false;
  const [realDir, root, additionalDirs] = await Promise.all([
    realDirOf(fs, absolute, pathClass),
    realDirOf(fs, project.root, pathClass),
    Promise.all(project.additionalDirs.map((scope) => realDirOf(fs, scope, pathClass))),
  ]);
  const realScope = { root, additionalDirs };
  return projectScopeContains(realScope, realDir, undefined) ||
    projectScopeContains(realScope, realDir, await locateCheckout(fs, absolute));
}

export async function isNonDirectory(fs: IHostFileSystem, dir: string): Promise<boolean> {
  try {
    if ((await fs.stat(dir)).isDirectory) return false;
    return !(await fs.stat(await fs.realpath(dir))).isDirectory;
  } catch {
    return false;
  }
}

function realDirOf(fs: IHostFileSystem, dir: string, pathClass: PathClass): Promise<string> {
  return realpathExistingPrefix(fs, ENVIRONMENT_PATHS[pathClass], dir, () => true);
}

function ownProjectOf(implicit: readonly ImplicitWorkspace[], dir: string): ImplicitWorkspace | undefined {
  const id = encodeWorkDirKey(dir);
  return implicit.find((project) => project.id === id) ??
    preferCanonical(implicit.filter((project) => sameDir(project.root, dir)));
}

async function repositoryDecision(
  location: GroupedCheckout,
  implicit: readonly ImplicitWorkspace[],
  ports: ImplicitResolutionPorts,
): Promise<ImplicitDecision> {
  const id = encodeWorkDirKey(location.mainDir);
  const hit = implicit.find((project) => project.id === id) ??
    preferCanonical(implicit.filter((project) =>
      sameDir(project.root, location.mainDir) || sameDir(project.root, location.canonicalMainDir),
    )) ??
    (await findByRealpath(implicit, location.canonicalMainDir, ports.realpath));
  return hit === undefined
    ? { kind: 'create', rule: 'repo', id, root: location.mainDir }
    : { kind: 'reuse', rule: 'repo', project: hit };
}

async function findByRealpath(
  implicit: readonly ImplicitWorkspace[],
  canonicalMainDir: string,
  realpath: (dir: string) => Promise<string | undefined>,
): Promise<ImplicitWorkspace | undefined> {
  const reals = await Promise.all(implicit.map((project) => realpath(project.root)));
  return preferCanonical(implicit.filter((_project, index) => {
    const real = reals[index];
    return real !== undefined && sameDir(real, canonicalMainDir);
  }));
}

function preferCanonical(matches: readonly ImplicitWorkspace[]): ImplicitWorkspace | undefined {
  return matches.find((project) => project.id === encodeWorkDirKey(project.root)) ?? matches[0];
}
