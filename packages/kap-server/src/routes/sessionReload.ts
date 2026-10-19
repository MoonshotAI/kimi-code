import {
  closeSessionById,
  ErrorCodes,
  isError2,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { requestLog } from '../lib/requestLog';

export async function reloadIfStale(
  core: Scope,
  sessionId: string,
  req: { id: string },
  error: unknown,
): Promise<void> {
  if (!isError2(error) || error.code !== ErrorCodes.SESSION_STALE) return;
  try {
    await closeSessionById(core.accessor, sessionId);
    await resumeSessionById(core.accessor, sessionId);
  } catch (reloadError) {
    requestLog(req)?.warn({ err: reloadError, session_id: sessionId }, 'stale session reload failed');
  }
}
