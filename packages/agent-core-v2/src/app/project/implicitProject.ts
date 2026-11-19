import { realpath } from 'node:fs/promises';

import { basename, join } from 'pathe';

import { directoryKey } from '#/_base/utils/paths';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { discoverRepository, type DiscoveredRepository, type RepositoryStore } from '#/app/git/repository';
import { Error2, ErrorCodes } from '#/errors';

import type { Project } from './project';

type ImplicitProject = Extract<Project, { kind: 'implicit' }>;

function findByOrigin(
  entries: ReadonlyMap<string, Project>,
  roots: ReadonlyMap<string, string>,
  directory: string,
): ImplicitProject | undefined {
  const exact = entries.get(encodeWorkDirKey(directory));
  if (exact?.kind === 'implicit') return exact;
  const key = workspaceRootKey(directory);
  for (const [id, root] of roots) {
    const project = entries.get(id);
    if (workspaceRootKey(root) === key && project?.kind === 'implicit') return project;
  }
  return undefined;
}

async function existingRepresentative(
  entries: ReadonlyMap<string, Project>,
  roots: ReadonlyMap<string, string>,
  repository: DiscoveredRepository,
): Promise<ImplicitProject | undefined> {
  const target = repository.defaultDirectory;
  if (target.kind !== 'unknown') {
    const byOrigin = findByOrigin(entries, roots, target.cwd);
    if (byOrigin !== undefined) return byOrigin;
  }
  for (const [id, root] of roots) {
    const existing = entries.get(id);
    if (existing?.kind !== 'implicit') continue;
    const physical = await realpath(root).catch(() => undefined);
    if (physical === undefined) continue;
    if (target.kind !== 'unknown') {
      if (directoryKey(physical) === directoryKey(target.cwd)) return existing;
    } else {
      const candidate = await discoverRepository(physical).catch(() => null);
      if (
        candidate !== null && directoryKey(candidate.vcs.store) === directoryKey(repository.vcs.store) &&
        candidate.defaultDirectory.kind === 'checkout' &&
        directoryKey(candidate.defaultDirectory.cwd) === directoryKey(physical)
      ) return existing;
    }
  }
  return undefined;
}

async function verifyRegisteredMain(
  project: Project,
  original: string,
  repository: DiscoveredRepository,
): Promise<void> {
  const current = repository.defaultDirectory;
  if (current.kind !== 'checkout' || repository.checkoutRoot === null) return;
  const main = directoryKey(current.cwd);
  if (
    directoryKey(repository.checkoutRoot) !== main ||
    directoryKey(join(current.cwd, '.git')) === directoryKey(repository.vcs.store) ||
    encodeWorkDirKey(current.cwd) === project.id ||
    directoryKey(original) === main
  ) return;
  const prior = await discoverRepository(original);
  if (
    prior?.defaultDirectory.kind === 'checkout' && prior.checkoutRoot !== null &&
    directoryKey(prior.vcs.store) === directoryKey(repository.vcs.store) &&
    directoryKey(prior.checkoutRoot) === directoryKey(prior.defaultDirectory.cwd) &&
    directoryKey(prior.checkoutRoot) !== main
  ) {
    throw new Error2(
      ErrorCodes.FS_GIT_UNAVAILABLE,
      `Git store ${repository.vcs.store} already has a main checkout at ${prior.checkoutRoot} and also reports ${current.cwd}`,
    );
  }
}

export async function resolveImplicitProject(
  entries: ReadonlyMap<string, Project>,
  roots: ReadonlyMap<string, string>,
  cwd: string,
  name?: string,
): Promise<Project> {
  let existing = findByOrigin(entries, roots, cwd);
  if (existing !== undefined && existing.vcs === undefined) {
    return { ...existing, lastOpenedAt: Date.now() };
  }
  const repository = await discoverRepository(cwd);
  let root = cwd;
  let vcs: RepositoryStore | undefined;
  if (repository !== null) {
    const key = directoryKey(repository.vcs.store);
    const bound = [...entries.values()].find(
      (project): project is ImplicitProject => project.vcs !== undefined && directoryKey(project.vcs.store) === key,
    );
    if (existing === undefined && bound !== undefined) {
      await verifyRegisteredMain(bound, roots.get(bound.id) ?? bound.root, repository);
      existing = bound;
    } else if (existing === undefined) {
      existing = await existingRepresentative(entries, roots, repository);
      if (repository.defaultDirectory.kind === 'unknown' && existing === undefined) {
        throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `Cannot locate the main checkout of ${repository.vcs.store}. Open the main checkout once before opening a linked worktree.`);
      }
      if (repository.defaultDirectory.kind !== 'unknown') root = repository.defaultDirectory.cwd;
      vcs = repository.vcs;
    }
    if (existing?.vcs !== undefined && directoryKey(existing.vcs.store) !== key) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, `Project ${existing.id} already belongs to Git store ${existing.vcs.store}, which conflicts with ${repository.vcs.store}`);
    }
  }
  if (existing !== undefined) {
    return { ...existing, ...(vcs === undefined ? {} : { vcs }), lastOpenedAt: Date.now() };
  }
  const project = newImplicitProject(root, name);
  if (entries.has(project.id)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Project ${project.id} already exists with a different kind`);
  }
  return vcs === undefined ? project : { ...project, vcs };
}

export function newImplicitProject(root: string, name = basename(root)): ImplicitProject {
  const now = Date.now();
  return {
    id: encodeWorkDirKey(root),
    kind: 'implicit',
    root,
    name,
    additionalDirs: [],
    createdAt: now,
    lastOpenedAt: now,
  };
}
