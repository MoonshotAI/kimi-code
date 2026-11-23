import { dirname, join } from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { FILE_HISTORY_BLOB_PREFIX } from './fileHistory';

export const FILE_HISTORY_SESSION_WINDOW = 30;

const RETENTION_DOC_SCOPE = 'file-history';

interface RetentionEntry {
  readonly id: string;
  readonly touchedAt: number;
}

interface RetentionDoc {
  readonly sessions: readonly RetentionEntry[];
}

interface FileHistorySession {
  readonly docs: IAtomicDocumentStore;
  readonly workspaceId: string;
  readonly placement: Pick<SessionMeta, 'environmentId' | 'environmentCwd'>;
  readonly sessionId: string;
}

export interface FileHistoryRetentionInput extends FileHistorySession {
  readonly hostFs: IHostFileSystem;
  readonly sessionDir: string;
}

const touchQueues = new Map<string, Promise<void>>();

function listKeyOf({ workspaceId, placement }: FileHistorySession): string {
  const { environmentId = LOCAL_ENVIRONMENT_ID, environmentCwd } = placement;
  return environmentId === LOCAL_ENVIRONMENT_ID && environmentCwd !== undefined
    ? `${workspaceId}.${encodeWorkDirKey(environmentCwd)}`
    : workspaceId;
}

function enqueue(listKey: string, work: () => Promise<void>): Promise<void> {
  const run = (touchQueues.get(listKey) ?? Promise.resolve()).then(work);
  touchQueues.set(listKey, run.catch(() => undefined));
  return run;
}

export function touchFileHistorySession(input: FileHistoryRetentionInput): Promise<void> {
  const listKey = listKeyOf(input);
  const leftEarlierList = listKey === input.workspaceId
    ? Promise.resolve()
    : enqueue(input.workspaceId, () => removeFromList(input, input.workspaceId));
  return leftEarlierList.then(() => enqueue(listKey, () => applyTouch(input, listKey))).catch(onUnexpectedError);
}

async function applyTouch(input: FileHistoryRetentionInput, listKey: string): Promise<void> {
  const doc =
    (await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, listKey)) ??
    { sessions: [] };
  const sessions = doc.sessions.filter((entry) => entry.id !== input.sessionId);
  sessions.push({ id: input.sessionId, touchedAt: Date.now() });
  sessions.sort((a, b) => a.touchedAt - b.touchedAt);
  const evicted = sessions.splice(0, Math.max(0, sessions.length - FILE_HISTORY_SESSION_WINDOW));
  const sessionsDir = dirname(input.sessionDir);
  const stuck: RetentionEntry[] = [];
  for (const victim of evicted) {
    const removed = await removeSessionBlobs(input.hostFs, join(sessionsDir, victim.id, 'agents'));
    if (!removed) stuck.push(victim);
  }
  if (stuck.length > 0) sessions.unshift(...stuck);
  await input.docs.set(RETENTION_DOC_SCOPE, listKey, { sessions });
}

function isMissingPathError(error: unknown): boolean {
  const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
  return code === 'ENOENT';
}

async function removeSessionBlobs(hostFs: IHostFileSystem, agentsDir: string): Promise<boolean> {
  let agentNames: readonly string[];
  try {
    const entries = await hostFs.readdir(agentsDir);
    agentNames = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch (error) {
    if (isMissingPathError(error)) return true;
    onUnexpectedError(error);
    return false;
  }
  let removed = true;
  for (const name of agentNames) {
    try {
      await hostFs.remove(join(agentsDir, name, FILE_HISTORY_BLOB_PREFIX));
    } catch (error) {
      if (isMissingPathError(error)) continue;
      onUnexpectedError(error);
      removed = false;
    }
  }
  return removed;
}

export function dropFileHistorySession(input: FileHistorySession): Promise<void> {
  const listKey = listKeyOf(input);
  return enqueue(listKey, () => removeFromList(input, listKey)).catch(onUnexpectedError);
}

async function removeFromList(input: FileHistorySession, listKey: string): Promise<void> {
  const doc = await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, listKey);
  if (doc === undefined) return;
  const sessions = doc.sessions.filter((entry) => entry.id !== input.sessionId);
  if (sessions.length === doc.sessions.length) return;
  await input.docs.set(RETENTION_DOC_SCOPE, listKey, { sessions });
}

export async function touchForkedFileHistory(input: FileHistoryRetentionInput): Promise<void> {
  const agentsDir = join(input.sessionDir, 'agents');
  let agentNames: readonly string[];
  try {
    const entries = await input.hostFs.readdir(agentsDir);
    agentNames = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of agentNames) {
    try {
      const blobs = await input.hostFs.readdir(join(agentsDir, name, FILE_HISTORY_BLOB_PREFIX));
      if (blobs.length > 0) {
        await touchFileHistorySession(input);
        return;
      }
    } catch {
      continue;
    }
  }
}
