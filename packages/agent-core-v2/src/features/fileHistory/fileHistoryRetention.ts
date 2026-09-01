import { dirname, join } from 'pathe';

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
  await input.docs.set(RETENTION_DOC_SCOPE, input.workspaceId, { sessions });
  const sessionsDir = dirname(input.sessionDir);
  for (const victim of evicted) {
    await removeSessionBlobs(input.hostFs, join(sessionsDir, victim.id, 'agents'));
  }
}

async function removeSessionBlobs(hostFs: IHostFileSystem, agentsDir: string): Promise<void> {
  let agentNames: readonly string[];
  try {
    const entries = await hostFs.readdir(agentsDir);
    agentNames = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of agentNames) {
    try {
      await hostFs.remove(join(agentsDir, name, FILE_HISTORY_BLOB_PREFIX));
    } catch (error) {
      onUnexpectedError(error);
    }
  }
}
