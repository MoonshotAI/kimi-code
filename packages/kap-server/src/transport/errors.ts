/**
 * `/api/v2` transport error handling — map internal errors onto the project
 * envelope, guard serialization, time-box calls, and gate access.
 */

import { ErrorCodes, Error2 } from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';

/** Thrown by {@link withTimeout} when a call exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`call timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise against a deadline. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

const KIMI_TO_PROTOCOL: Record<string, ErrorCode> = {
  [ErrorCodes.SESSION_NOT_FOUND]: ErrorCode.SESSION_NOT_FOUND,
  // v1 maps a missing agent onto the session-not-found envelope; keep parity.
  [ErrorCodes.AGENT_NOT_FOUND]: ErrorCode.SESSION_NOT_FOUND,
  [ErrorCodes.SESSION_UNDO_UNAVAILABLE]: ErrorCode.SESSION_UNDO_UNAVAILABLE,
  [ErrorCodes.REQUEST_INVALID]: ErrorCode.VALIDATION_FAILED,
  [ErrorCodes.NOT_IMPLEMENTED]: ErrorCode.INTERNAL_ERROR,
  [ErrorCodes.PROMPT_NOT_FOUND]: ErrorCode.PROMPT_NOT_FOUND,
  [ErrorCodes.FS_PATH_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.SESSION_BUSY]: ErrorCode.SESSION_BUSY,
  [ErrorCodes.PROMPT_ALREADY_COMPLETED]: ErrorCode.PROMPT_ALREADY_COMPLETED,
  [ErrorCodes.GOAL_ALREADY_EXISTS]: ErrorCode.GOAL_ALREADY_EXISTS,
  [ErrorCodes.GOAL_NOT_FOUND]: ErrorCode.GOAL_NOT_FOUND,
  [ErrorCodes.GOAL_STATUS_INVALID]: ErrorCode.GOAL_STATUS_INVALID,
  [ErrorCodes.GOAL_NOT_RESUMABLE]: ErrorCode.GOAL_NOT_RESUMABLE,
  [ErrorCodes.GOAL_OBJECTIVE_EMPTY]: ErrorCode.GOAL_OBJECTIVE_EMPTY,
  [ErrorCodes.GOAL_OBJECTIVE_TOO_LONG]: ErrorCode.GOAL_OBJECTIVE_TOO_LONG,
  [ErrorCodes.GOAL_UNSUPPORTED_AGENT]: ErrorCode.GOAL_UNSUPPORTED_AGENT,
  // hostFs / storage codes → closest v1 wire equivalent (ENOTDIR collapses
  // into path-not-found); codes without an equivalent fall back to 50001.
  [ErrorCodes.OS_FS_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.OS_FS_NOT_DIRECTORY]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.OS_FS_IS_DIRECTORY]: ErrorCode.FS_IS_DIRECTORY,
  [ErrorCodes.OS_FS_ALREADY_EXISTS]: ErrorCode.FS_ALREADY_EXISTS,
  [ErrorCodes.OS_FS_PERMISSION_DENIED]: ErrorCode.FS_PERMISSION_DENIED,
  [ErrorCodes.STORAGE_IO_FAILED]: ErrorCode.PERSISTENCE_FAILURE,
  [ErrorCodes.STORAGE_LOCKED]: ErrorCode.PERSISTENCE_FAILURE,
};

/**
 * Map an internal error to the project envelope. `Error2` keeps its coded
 * mapping; everything else becomes `50001`. Stack traces are intentionally not
 * surfaced.
 */
export function mapError(err: unknown, requestId: string): ReturnType<typeof errEnvelope> {
  if (err instanceof Error2) {
    const code = KIMI_TO_PROTOCOL[err.code] ?? ErrorCode.INTERNAL_ERROR;
    return errEnvelope(code, err.message, requestId, err.stack);
  }
  if (err instanceof TimeoutError) {
    return errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, requestId, err.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
    requestId,
    err instanceof Error ? err.stack : undefined,
  );
}

/** Build a `40001` envelope with structured details. */
export function validationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

/**
 * Ensure a value survives a JSON round-trip (catches circular refs, `BigInt`,
 * functions). Returns the value unchanged; throws `Error2` on failure so the
 * caller maps it to `50001` with a clear message.
 */
export function assertSerializable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error2(
      ErrorCodes.INTERNAL,
      `result not serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}
