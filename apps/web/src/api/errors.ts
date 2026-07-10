// apps/kimi-web/src/api/errors.ts
// DaemonApiError, DaemonNetworkError, and type guard.

export class DaemonApiError extends Error {
  readonly code: number;
  readonly requestId: string;
  readonly details: unknown;
  /** Epoch ms when the failure was surfaced. */
  readonly timestamp?: number;
  /** Round-trip time from request start to the error envelope, in ms. */
  readonly durationMs?: number;

  constructor(input: {
    code: number;
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
  readonly cause: unknown;
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
