import { ErrorCodes, Error2 } from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`call timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

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
  [ErrorCodes.AGENT_NOT_FOUND]: ErrorCode.SESSION_NOT_FOUND,
  [ErrorCodes.SESSION_UNDO_UNAVAILABLE]: ErrorCode.SESSION_UNDO_UNAVAILABLE,
  [ErrorCodes.REQUEST_INVALID]: ErrorCode.VALIDATION_FAILED,
  [ErrorCodes.CONFIG_INVALID]: ErrorCode.VALIDATION_FAILED,
  [ErrorCodes.NOT_IMPLEMENTED]: ErrorCode.INTERNAL_ERROR,
  [ErrorCodes.PROMPT_NOT_FOUND]: ErrorCode.PROMPT_NOT_FOUND,
  [ErrorCodes.FS_PATH_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.SESSION_BUSY]: ErrorCode.SESSION_BUSY,
  [ErrorCodes.SESSION_FORK_ACTIVE_TURN]: ErrorCode.SESSION_BUSY,
  [ErrorCodes.SESSION_OCCUPIED]: ErrorCode.SESSION_OCCUPIED,
  [ErrorCodes.SESSION_STALE]: ErrorCode.SESSION_STALE,
  [ErrorCodes.COMPACTION_UNABLE]: ErrorCode.COMPACTION_UNABLE,
  [ErrorCodes.FILE_NOT_FOUND]: ErrorCode.FILE_NOT_FOUND,
  [ErrorCodes.SKILL_NOT_FOUND]: ErrorCode.SKILL_NOT_FOUND,
  [ErrorCodes.SKILL_NAME_EMPTY]: ErrorCode.SKILL_NOT_FOUND,
  [ErrorCodes.SKILL_TYPE_UNSUPPORTED]: ErrorCode.SKILL_NOT_ACTIVATABLE,
  [ErrorCodes.VALIDATION_FAILED]: ErrorCode.VALIDATION_FAILED,
  [ErrorCodes.PROMPT_ID_CONFLICT]: ErrorCode.PROMPT_ID_CONFLICT,
  [ErrorCodes.GOAL_ALREADY_EXISTS]: ErrorCode.GOAL_ALREADY_EXISTS,
  [ErrorCodes.GOAL_NOT_FOUND]: ErrorCode.GOAL_NOT_FOUND,
  [ErrorCodes.GOAL_STATUS_INVALID]: ErrorCode.GOAL_STATUS_INVALID,
  [ErrorCodes.GOAL_NOT_RESUMABLE]: ErrorCode.GOAL_NOT_RESUMABLE,
  [ErrorCodes.GOAL_OBJECTIVE_EMPTY]: ErrorCode.GOAL_OBJECTIVE_EMPTY,
  [ErrorCodes.GOAL_OBJECTIVE_TOO_LONG]: ErrorCode.GOAL_OBJECTIVE_TOO_LONG,
  [ErrorCodes.GOAL_UNSUPPORTED_AGENT]: ErrorCode.GOAL_UNSUPPORTED_AGENT,
  [ErrorCodes.OS_FS_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.OS_FS_NOT_DIRECTORY]: ErrorCode.FS_PATH_NOT_FOUND,
  [ErrorCodes.OS_FS_IS_DIRECTORY]: ErrorCode.FS_IS_DIRECTORY,
  [ErrorCodes.OS_FS_ALREADY_EXISTS]: ErrorCode.FS_ALREADY_EXISTS,
  [ErrorCodes.OS_FS_PERMISSION_DENIED]: ErrorCode.FS_PERMISSION_DENIED,
  [ErrorCodes.STORAGE_IO_FAILED]: ErrorCode.PERSISTENCE_FAILURE,
  [ErrorCodes.STORAGE_LOCKED]: ErrorCode.PERSISTENCE_FAILURE,
};

const PUBLIC_DETAIL_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.SESSION_OCCUPIED,
  ErrorCodes.SESSION_STALE,
]);

export function mapError(err: unknown, requestId: string): ReturnType<typeof errEnvelope> {
  if (err instanceof Error2) {
    const code = KIMI_TO_PROTOCOL[err.code] ?? ErrorCode.INTERNAL_ERROR;
    const details = PUBLIC_DETAIL_CODES.has(err.code) ? err.details : undefined;
    return errEnvelope(code, err.message, requestId, err.stack, details);
  }
  if (err instanceof TimeoutError) {
    return errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, requestId, err.stack);
  }
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    const osCode = {
      ENOENT: ErrorCode.FS_PATH_NOT_FOUND,
      ENOTDIR: ErrorCode.FS_PATH_NOT_FOUND,
      EACCES: ErrorCode.FS_PERMISSION_DENIED,
      EPERM: ErrorCode.FS_PERMISSION_DENIED,
      EEXIST: ErrorCode.FS_ALREADY_EXISTS,
      'os.fs.not_found': ErrorCode.FS_PATH_NOT_FOUND,
      'os.fs.not_directory': ErrorCode.FS_PATH_NOT_FOUND,
      'os.fs.permission_denied': ErrorCode.FS_PERMISSION_DENIED,
      'os.fs.already_exists': ErrorCode.FS_ALREADY_EXISTS,
      'os.fs.is_directory': ErrorCode.FS_IS_DIRECTORY,
    }[code];
    if (osCode !== undefined) return errEnvelope(osCode, err instanceof Error ? err.message : String(err), requestId);
    if (code.startsWith('runtime.') || code.startsWith('device.')) {
      const protocolCode = code === 'runtime.not_found'
        ? ErrorCode.RUNTIME_NOT_FOUND
        : code === 'runtime.denied'
          ? ErrorCode.RUNTIME_DENIED
          : code === 'runtime.unsupported' || code === 'runtime.capability_unavailable'
            ? ErrorCode.RUNTIME_UNSUPPORTED
            : code === 'runtime.write_uncertain'
              ? ErrorCode.RUNTIME_WRITE_UNCERTAIN
              : code === 'runtime.timeout'
                ? ErrorCode.RUNTIME_TIMEOUT
                : code === 'runtime.too_large'
                  ? ErrorCode.FS_TOO_LARGE
                  : ErrorCode.RUNTIME_UNAVAILABLE;
      const candidate = err as { retryable?: unknown; uncertain?: unknown };
      return errEnvelope(
        protocolCode,
        err instanceof Error ? err.message : String(err),
        requestId,
        err instanceof Error ? err.stack : undefined,
        {
          runtime_error: {
            code,
            retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : undefined,
            uncertain: typeof candidate.uncertain === 'boolean' ? candidate.uncertain : undefined,
          },
        },
      );
    }
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
    requestId,
    err instanceof Error ? err.stack : undefined,
  );
}

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
