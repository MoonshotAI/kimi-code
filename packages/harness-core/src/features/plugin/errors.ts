export type PluginErrorCode =
  | 'plugin.load_failed'
  | 'plugin.not_found'
  | 'validation.failed'
  | 'fs.path_not_found'
  | 'mcp.server_not_found';

export interface PluginErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: PluginErrorCode, message: string, options?: PluginErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PluginError';
    this.code = code;
    this.details = options?.details;
  }
}
