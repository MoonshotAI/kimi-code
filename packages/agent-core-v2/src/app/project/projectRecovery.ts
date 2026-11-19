import { isAbsolute } from 'pathe';

import type { ILogger } from '#/_base/log/log';
import { encodeWorkDirKey, isWorkDirKey } from '#/_base/utils/workdir-slug';
import { discoverRepository } from '#/app/git/repository';
import { listSessionIds, listWorkspaceIds, readSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import { newImplicitProject } from './implicitProject';
import type { Project } from './project';
import { readSessionIndexEntries, sessionIndexBucket } from '#/app/workspace/workspaceAlias';
import type { WorkspaceCatalog } from '#/app/workspace/workspacePersistence';

export async function recoverImplicitProjects(
  catalog: WorkspaceCatalog,
  storage: IFileSystemStorageService,
  docs: IAtomicDocumentStore,
  log: ILogger,
): Promise<readonly Project[]> {
  const known = new Set([...catalog.workspaces.map((project) => project.id), ...catalog.deletedIds]);
  const unresolved = (id: string) => isWorkDirKey(id) && !known.has(id);
  const recovered: Project[] = [];
  const recover = (id: string, root: string) => {
    known.add(id);
    recovered.push(newImplicitProject(root));
  };
  const hints = new Map<string, Set<string>>();
  for (const entry of await readSessionIndexEntries(storage)) {
    const id = sessionIndexBucket(entry);
    if (id === undefined || !unresolved(id) || !isAbsolute(entry.workDir)) continue;
    if (encodeWorkDirKey(entry.workDir) === id) {
      recover(id, entry.workDir);
    } else {
      const dirs = hints.get(id) ?? new Set<string>();
      dirs.add(entry.workDir);
      hints.set(id, dirs);
    }
  }
  const representative = async (id: string, cwd: string): Promise<string | undefined> => {
    try {
      const directory = (await discoverRepository(cwd))?.defaultDirectory;
      if (directory !== undefined && directory.kind !== 'unknown' && encodeWorkDirKey(directory.cwd) === id) {
        return directory.cwd;
      }
    } catch (error) {
      log.warn('Could not identify the repository for a historical session', { projectId: id, cwd, error: String(error) });
    }
    return undefined;
  };
  for (const [id, dirs] of hints) {
    if (!unresolved(id)) continue;
    for (const cwd of dirs) {
      const root = await representative(id, cwd);
      if (root !== undefined) {
        recover(id, root);
        break;
      }
    }
  }
  for (const id of await listWorkspaceIds(storage, 'sessions')) {
    if (!unresolved(id)) continue;
    const tried = hints.get(id) ?? new Set<string>();
    for (const sessionId of await listSessionIds(storage, 'sessions', id)) {
      const session = await readSessionSummary(docs, 'sessions', id, sessionId);
      if (session === undefined) continue;
      const local = session.environmentId === undefined || session.environmentId === LOCAL_ENVIRONMENT_ID;
      const cwd = local ? session.environmentCwd ?? session.cwd : session.cwd;
      if (cwd === undefined || !isAbsolute(cwd) || tried.has(cwd)) continue;
      tried.add(cwd);
      const root = encodeWorkDirKey(cwd) === id ? cwd : local ? await representative(id, cwd) : undefined;
      if (root !== undefined) {
        recover(id, root);
        break;
      }
    }
  }
  return recovered;
}
