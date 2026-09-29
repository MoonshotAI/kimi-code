export type SessionExportErrorCode =
  | 'session.export_not_found'
  | 'session.export_missing_version'
  | 'session.export_output_conflict'
  | 'session.export_too_large'
  | 'session.export_not_a_file';

export interface SessionExportErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class SessionExportError extends Error {
  readonly code: SessionExportErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: SessionExportErrorCode, message: string, options?: SessionExportErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionExportError';
    this.code = code;
    this.details = options?.details;
  }
}
