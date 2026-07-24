/**
 * `workspace` domain (L2) — alias-folding pure helpers.
 *
 * One physical folder can arrive under several id spellings (Windows
 * drive-letter casing, slash direction, typed-vs-realpath variants, legacy
 * `encodeWorkDirKey` outputs). These helpers enumerate or collapse those
 * spellings without owning any state: `collectAliasIds` expands one root to
 * every id that addresses it, `dedupeByRoot` collapses a catalog to one
 * representative per directory. Shared by `WorkspaceService` (delete and
 * list) and `WorkspaceAliasesService` (`resolveAliasIds`).
 */

import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';

import type { Workspace } from './workspace';

interface WorkspaceAliasSource {
  readonly workDir: string;
}

export function collectAliasIds(
  workspaces: readonly Workspace[],
  sessionIndexEntries: readonly WorkspaceAliasSource[],
  root: string,
): string[] {
  const rootKey = workspaceRootKey(root);
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (alias: string): void => {
    if (seen.has(alias)) return;
    seen.add(alias);
    ids.push(alias);
  };
  for (const ws of workspaces) {
    if (workspaceRootKey(ws.root) === rootKey) add(ws.id);
  }
  for (const line of sessionIndexEntries) {
    if (workspaceRootKey(line.workDir) === rootKey) add(encodeWorkDirKey(line.workDir));
  }
  return ids;
}

export function dedupeByRoot(byId: ReadonlyMap<string, Workspace>): Workspace[] {
  const byRoot = new Map<string, Workspace>();
  for (const ws of byId.values()) {
    const rootKey = workspaceRootKey(ws.root);
    const existing = byRoot.get(rootKey);
    if (existing === undefined) {
      byRoot.set(rootKey, ws);
      continue;
    }
    const canonicalId = encodeWorkDirKey(ws.root);
    if (existing.id !== canonicalId && ws.id === canonicalId) {
      byRoot.set(rootKey, ws);
    }
  }
  return [...byRoot.values()];
}
