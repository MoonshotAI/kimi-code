import { dirname, join } from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

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

export interface FileHistoryRetentionInput {
  readonly docs: IAtomicDocumentStore;
  readonly hostFs: IHostFileSystem;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly sessionId: string;
}

const touchQueues = new Map<string, Promise<void>>();

export function touchFileHistorySession(input: FileHistoryRetentionInput): Promise<void> {
  const previous = touchQueues.get(input.workspaceId) ?? Promise.resolve();
  const run = previous.then(() => applyTouch(input)).catch(onUnexpectedError);
  touchQueues.set(input.workspaceId, run);
  return run;
}

async function applyTouch(input: FileHistoryRetentionInput): Promise<void> {
  const doc =
    (await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, input.workspaceId)) ??
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
  await input.docs.set(RETENTION_DOC_SCOPE, input.workspaceId, { sessions });
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

export function dropFileHistorySession(input: {
  readonly docs: IAtomicDocumentStore;
  readonly workspaceId: string;
  readonly sessionId: string;
}): Promise<void> {
  const previous = touchQueues.get(input.workspaceId) ?? Promise.resolve();
  const run = previous
    .then(async () => {
      const doc = await input.docs.get<RetentionDoc>(RETENTION_DOC_SCOPE, input.workspaceId);
      if (doc === undefined) return;
      const sessions = doc.sessions.filter((entry) => entry.id !== input.sessionId);
      if (sessions.length === doc.sessions.length) return;
      await input.docs.set(RETENTION_DOC_SCOPE, input.workspaceId, { sessions });
    })
    .catch(onUnexpectedError);
  touchQueues.set(input.workspaceId, run);
  return run;
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
