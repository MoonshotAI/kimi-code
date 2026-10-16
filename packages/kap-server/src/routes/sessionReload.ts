import {
  closeSessionById,
  isError2,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

export function isSessionStale(error: unknown): boolean {
  return isError2(error) && error.code === 'session.stale';
}

export async function reloadStaleSession(core: Scope, sessionId: string): Promise<void> {
  await closeSessionById(core.accessor, sessionId);
  await resumeSessionById(core.accessor, sessionId);
}
