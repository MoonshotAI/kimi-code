export type ModelsDevErrorCode =
  | 'modelsDev.catalog_unavailable'
  | 'modelsDev.catalog_entry_not_found'
  | 'modelsDev.import_invalid'
  | 'modelsDev.registry_import_invalid'
  | 'provider.oauth_managed'
  | 'config.unavailable';

export interface ModelsDevErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class ModelsDevError extends Error {
  readonly code: ModelsDevErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ModelsDevErrorCode, message: string, options?: ModelsDevErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelsDevError';
    this.code = code;
    this.details = options?.details;
  }
}
