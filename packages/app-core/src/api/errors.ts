
export class DaemonApiError extends Error {
  readonly code: number | undefined;
  readonly requestId: string;
  readonly details: unknown;
  readonly timestamp?: number;
  readonly durationMs?: number;

  constructor(input: {
    code: number | undefined;
    msg: string;
    requestId: string;
    details?: unknown;
    timestamp?: number;
    durationMs?: number;
  }) {
    super(input.msg);
    this.name = 'DaemonApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.details = input.details;
    this.timestamp = input.timestamp;
    this.durationMs = input.durationMs;
  }
}

export class DaemonNetworkError extends Error {
  override readonly cause: unknown;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly requestId: string;
  readonly phase: 'fetch' | 'parse';
  readonly timeoutMs: number;
  readonly status?: number;
  readonly statusText?: string;
  readonly contentType?: string;
  readonly bodyPreview?: string;
  readonly timestamp?: number;
  readonly durationMs?: number;

  constructor(input: {
    message: string;
    cause: unknown;
    method: string;
    path: string;
    url: string;
    requestId: string;
    phase: 'fetch' | 'parse';
    timeoutMs: number;
    status?: number;
    statusText?: string;
    contentType?: string;
    bodyPreview?: string;
    timestamp?: number;
    durationMs?: number;
  }) {
    super(input.message);
    this.name = 'DaemonNetworkError';
    this.cause = input.cause;
    this.method = input.method;
    this.path = input.path;
    this.url = input.url;
    this.requestId = input.requestId;
    this.phase = input.phase;
    this.timeoutMs = input.timeoutMs;
    this.status = input.status;
    this.statusText = input.statusText;
    this.contentType = input.contentType;
    this.bodyPreview = input.bodyPreview;
    this.timestamp = input.timestamp;
    this.durationMs = input.durationMs;
  }
}

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(input: { size: number; limit: number }) {
    super(`file too large to preview: ${input.size} bytes (limit ${input.limit})`);
    this.name = 'FileTooLargeError';
    this.size = input.size;
    this.limit = input.limit;
  }
}

export function isDaemonApiError(error: unknown): error is DaemonApiError {
  return (
    error instanceof DaemonApiError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'DaemonApiError' &&
      typeof (error as { code?: unknown }).code === 'number')
  );
}

export function isDaemonNetworkError(error: unknown): error is DaemonNetworkError {
  return (
    error instanceof DaemonNetworkError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'DaemonNetworkError' &&
      typeof (error as { method?: unknown }).method === 'string' &&
      typeof (error as { path?: unknown }).path === 'string')
  );
}

export function isDaemonTimeoutError(error: unknown): boolean {
  return (
    isDaemonNetworkError(error) &&
    typeof error.cause === 'object' &&
    error.cause !== null &&
    (error.cause as { name?: unknown }).name === 'TimeoutError'
  );
}

export function isFileTooLargeError(error: unknown): error is FileTooLargeError {
  return (
    error instanceof FileTooLargeError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FileTooLargeError' &&
      typeof (error as { limit?: unknown }).limit === 'number')
  );
}

export const SESSION_EXPORT_TOO_LARGE_CODE = 41301;

export const SESSION_BUSY_CODE = 40901;

export const SESSION_NOT_FOUND_CODE = 40401;

export const PAGE_TOKEN_MISMATCH_CODE = 40922;

export function isPageTokenMismatchError(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === PAGE_TOKEN_MISMATCH_CODE;
}

export const SESSION_STALE_CODE = 40932;

export const SESSION_OCCUPIED_CODE = 40931;

export const FS_VALIDATION_FAILED_CODE = 40001;

export const FS_PATH_NOT_FOUND_CODE = 40409;

export const FS_PERMISSION_DENIED_CODE = 40411;

export const FS_ALREADY_EXISTS_CODE = 40919;

export function isSessionStaleError(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === SESSION_STALE_CODE;
}

export function isSessionOccupiedError(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === SESSION_OCCUPIED_CODE;
}

export function sessionOccupiedHolderClient(error: unknown): string | undefined {
  if (!isDaemonApiError(error) || error.code !== SESSION_OCCUPIED_CODE) return undefined;
  const details = error.details as { holder?: { clientIdentity?: unknown } } | null | undefined;
  const identity = typeof details === 'object' ? details?.holder?.clientIdentity : undefined;
  return typeof identity === 'string' && identity !== '' ? identity : undefined;
}

export function sessionOccupiedHolderDisplayName(error: unknown): string | undefined {
  if (!isDaemonApiError(error) || error.code !== SESSION_OCCUPIED_CODE) return undefined;
  const details = error.details as { holder?: { clientDisplayName?: unknown } } | null | undefined;
  const displayName = typeof details === 'object' ? details?.holder?.clientDisplayName : undefined;
  return typeof displayName === 'string' && displayName !== '' ? displayName : undefined;
}
