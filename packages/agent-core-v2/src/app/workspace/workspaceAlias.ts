import { isAbsolute } from 'pathe';

import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { Workspace } from './workspace';

export const SESSION_INDEX_SCOPE = '';
export const SESSION_INDEX_KEY = 'session_index.jsonl';

const textDecoder = new TextDecoder();

export interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export function collectAliasIds(
  workspaces: readonly Workspace[],
  sessionIndexEntries: readonly SessionIndexLine[],
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

export async function readSessionIndexEntries(
  storage: IFileSystemStorageService,
): Promise<SessionIndexLine[]> {
  const bytes = await storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
  if (bytes === undefined) return [];
  const entries: SessionIndexLine[] = [];
  for (const line of textDecoder.decode(bytes).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseSessionIndexLine(trimmed);
    if (entry === undefined) continue;
    entries.push(entry);
  }
  return entries;
}

export async function readSessionIndexWorkDirs(
  storage: IFileSystemStorageService,
): Promise<readonly string[]> {
  const workDirs: string[] = [];
  for (const entry of await readSessionIndexEntries(storage)) {
    if (!isAbsolute(entry.workDir)) continue;
    workDirs.push(entry.workDir);
  }
  return workDirs;
}

export function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexLine>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}
