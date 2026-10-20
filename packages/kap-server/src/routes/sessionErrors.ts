import {
  ErrorCodes,
  isError2,
  type DefaultWorkspaceUnavailableError,
} from '@moonshot-ai/agent-core-v2';

import { requestLog } from '../lib/requestLog';
import { ErrorCode } from '../protocol/error-codes';
import { mapError } from '../transport/errors';

export const sessionConflictErrors = {
  [ErrorCode.SESSION_OCCUPIED]: {},
  [ErrorCode.SESSION_STALE]: {},
} as const;

export function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): void {
  if (isError2(error) && error.code === ErrorCodes.DEFAULT_WORKSPACE_UNAVAILABLE) {
    const { path, reason } = (error as DefaultWorkspaceUnavailableError).details;
    reply.send({
      code: ErrorCode.DEFAULT_WORKSPACE_UNAVAILABLE,
      msg: error.message,
      data: { path, reason },
      request_id: req.id,
    });
    return;
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
