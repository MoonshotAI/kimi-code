import { ErrorCodes, isError2, type Scope } from '@moonshot-ai/agent-core-v2';

import { requestLog } from '../lib/requestLog';
import { ErrorCode } from '../protocol/error-codes';
import { mapError } from '../transport/errors';
import { isSessionStale, reloadStaleSession } from './sessionReload';

export const sessionConflictErrors = {
  [ErrorCode.SESSION_OCCUPIED]: {},
  [ErrorCode.SESSION_STALE]: {},
} as const;

export async function sendSessionError(
  core: Scope,
  sessionId: string | undefined,
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): Promise<void> {
  if (sessionId !== undefined && isSessionStale(error)) {
    await reloadStaleSession(core, sessionId).catch(() => undefined);
  }
  if (isError2(error) && error.code === ErrorCodes.SESSION_UNDO_UNAVAILABLE) {
    reply.send({
      code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
      msg: error.message,
      data: error.details ?? null,
      request_id: req.id,
      stack: error.stack,
    });
    return;
  }
  const envelope = mapError(error, req.id);
  if (envelope.code === ErrorCode.INTERNAL_ERROR) {
    requestLog(req)?.error({ err: error }, 'session request failed');
  }
  reply.send(envelope);
}
