/**
 * Public error-code registry (`ErrorCodes`, `ErrorCode`) and per-code metadata
 * (`ERROR_INFO`, `errorInfo`) surfaced to SDK/RPC consumers.
 */

export const ErrorCodes = {
  INTERNAL: 'internal',
  NOT_IMPLEMENTED: 'not_implemented',
  CANCELED: 'canceled',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export const ERROR_INFO = {
  internal: {
    title: 'Internal error',
    retryable: false,
    public: true,
    action: 'Inspect logs or report the issue with diagnostics.',
  },
  not_implemented: {
    title: 'Not implemented',
    retryable: false,
    public: true,
    action: 'This feature is not implemented yet.',
  },
  canceled: {
    title: 'Canceled',
    retryable: false,
    public: true,
    action: 'The operation was canceled by the user or an abort signal.',
  },
} as const satisfies Record<ErrorCode, ErrorInfo>;

export function errorInfo(code: ErrorCode): ErrorInfo {
  return ERROR_INFO[code];
}
