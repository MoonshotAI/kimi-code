import { FileStorageService } from '@moonshot-ai/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { JsonAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import {
  listWorkspaceIds,
  listSessionIds,
  readSessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndexSource';
import type { SessionSummary } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';

export async function listSessionsV2(homeDir: string): Promise<readonly SessionSummary[]> {
  const storage = new FileStorageService(homeDir);
  const docs = new JsonAtomicDocumentStore(storage);
  const out: SessionSummary[] = [];
  for (const workspaceId of await listWorkspaceIds(storage, 'sessions')) {
    for (const sessionId of await listSessionIds(storage, 'sessions', workspaceId)) {
      const summary = await readSessionSummary(docs, 'sessions', workspaceId, sessionId);
      if (summary !== undefined) out.push(summary);
    }
  }
  return out;
}

export async function readSessionSummaryV2(
  homeDir: string,
  sessionId: string,
): Promise<SessionSummary | undefined> {
  const sessions = await listSessionsV2(homeDir);
  return sessions.find((s) => s.id === sessionId);
}
