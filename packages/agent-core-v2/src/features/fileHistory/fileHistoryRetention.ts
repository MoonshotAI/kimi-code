import { dirname, join } from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { workDirToPin } from '#/session/workspaceContext/workspaceRoots';

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
  readonly projectRoot?: string;
  readonly placement: Pick<SessionMeta, 'environmentId' | 'environmentCwd'>;
  readonly sessionId: string;
}

export interface FileHistoryRetentionInput extends FileHistorySession {
  readonly hostFs: IHostFileSystem;
  readonly sessionDir: string;
}

export interface RelocateFileHistorySessionInput {
  readonly docs: IAtomicDocumentStore;
  readonly workspaceId: string;
  readonly projectRoot?: string;
  readonly sessionId: string;
  readonly fromPlacement: Pick<SessionMeta, 'environmentId' | 'environmentCwd'>;
  readonly toPlacement: Pick<SessionMeta, 'environmentId' | 'environmentCwd'>;
}

const touchQueues = new Map<string, Promise<void>>();

function listKeyOf({ workspaceId, projectRoot, placement }: FileHistorySession): string {
  const { environmentId = LOCAL_ENVIRONMENT_ID, environmentCwd } = placement;
  const ownDir = environmentId === LOCAL_ENVIRONMENT_ID && environmentCwd !== undefined
    ? projectRoot === undefined ? environmentCwd : workDirToPin(environmentCwd, projectRoot)
    : undefined;
  return ownDir === undefined ? workspaceId : `${workspaceId}.${encodeWorkDirKey(ownDir)}`;
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

export async function relocateFileHistorySession(
  input: RelocateFileHistorySessionInput,
): Promise<void> {
  const fromKey = listKeyOf({
    docs: input.docs,
    workspaceId: input.workspaceId,
    projectRoot: input.projectRoot,
    placement: input.fromPlacement,
    sessionId: input.sessionId,
  });
  const toKey = listKeyOf({
    docs: input.docs,
    workspaceId: input.workspaceId,
    projectRoot: input.projectRoot,
    placement: input.toPlacement,
    sessionId: input.sessionId,
  });
  if (fromKey === toKey) return;
  let movedEntry: RetentionEntry | undefined;
  await enqueue(fromKey, async () => {
    const doc = await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, fromKey);
    if (doc === undefined) return;
    movedEntry = doc.sessions.find((entry) => entry.id === input.sessionId);
    if (movedEntry === undefined) return;
    const sessions = doc.sessions.filter((entry) => entry.id !== input.sessionId);
    await input.docs.set(RETENTION_DOC_SCOPE, fromKey, { sessions });
  }).catch(onUnexpectedError);
  if (movedEntry === undefined) return;
  const entryToInsert = movedEntry;
  await enqueue(toKey, async () => {
    const doc = (await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, toKey)) ?? {
      sessions: [],
    };
    const sessions = doc.sessions.filter((entry) => entry.id !== input.sessionId);
    sessions.push(entryToInsert);
    sessions.sort((left, right) => left.touchedAt - right.touchedAt);
    await input.docs.set(RETENTION_DOC_SCOPE, toKey, { sessions });
  }).catch(onUnexpectedError);
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
