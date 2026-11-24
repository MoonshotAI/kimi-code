import { ErrorCodes, isError2 } from '@moonshot-ai/agent-core-v2';

import { requestLog } from '../lib/requestLog';
import { ErrorCode } from '../protocol/error-codes';
import { undoUnavailableDataSchema, type UndoUnavailableData } from '../protocol/rest-session';
import { mapError } from '../transport/errors';

export const sessionConflictErrors = {
  [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
  [ErrorCode.SESSION_OCCUPIED]: {},
  [ErrorCode.SESSION_STALE]: {},
} as const;

export function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): void {
  if (isError2(error) && error.code === ErrorCodes.SESSION_UNDO_UNAVAILABLE) {
    reply.send({
      code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
      msg: error.message,
      data: undoUnavailableData(error.details),
      request_id: req.id,
    });
    return;
  }
  const envelope = mapError(error, req.id);
  if (envelope.code === ErrorCode.INTERNAL_ERROR) {
    requestLog(req)?.error({ err: error }, 'session request failed');
  }
  reply.send(envelope);
}

function undoUnavailableData(
  details: Readonly<Record<string, unknown>> | undefined,
): UndoUnavailableData | null {
  if (details === undefined) return null;
  return undoUnavailableDataSchema.parse({
    reason: details['reason'],
    requested_count: details['requestedCount'],
    undoable_count: details['undoableCount'],
  });
}
