// apps/kimi-web/src/api/errors.ts
// DaemonApiError, DaemonNetworkError, and type guard.

export class DaemonApiError extends Error {
  /** The numeric envelope code. Undefined when the daemon answered with a
      non-envelope error (e.g. an old server's bare fastify 404). */
  readonly code: number | undefined;
  readonly requestId: string;
  readonly details: unknown;
  /** Epoch ms when the failure was surfaced. */
  readonly timestamp?: number;
  /** Round-trip time from request start to the error envelope, in ms. */
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
  /** Epoch ms when the failure was surfaced. */
  readonly timestamp?: number;
  /** Round-trip time from request start to failure, in ms. */
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

/** A host-side preview read was refused because the file exceeds the client
 *  size cap (fs:content streams the whole body; the renderer decodes it in
 *  full, so an unbounded read could OOM the app). Raised by
 *  readHostFileContent; the file preview maps it to a dedicated error state. */
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

export function isFileTooLargeError(error: unknown): error is FileTooLargeError {
  return (
    error instanceof FileTooLargeError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FileTooLargeError' &&
      typeof (error as { limit?: unknown }).limit === 'number')
  );
}
