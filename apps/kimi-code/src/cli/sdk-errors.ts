/**
 * Local Kimi error surface — ported (trimmed) from
 * `@moonshot-ai/kimi-code-sdk` `legacy/errors.ts` (G-1 CLI consumption
 * cutover). The host only needs the code table entries it actually reads,
 * structural `isKimiError` (cross-boundary payloads are plain objects), and
 * the title lookup.
 */

import { t } from '#/i18n';

/** The single Kimi error class (host-side minimal shape). */
export class KimiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: string, message: string, options: { readonly details?: Record<string, unknown>; readonly cause?: unknown } = {}) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

/** Error codes the CLI host branches on (subset of the SDK table). */
export const ErrorCodes = {
  AUTH_LOGIN_REQUIRED: 'auth.login_required',
  SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',
} as const;

const KIMI_ERROR_TITLE_KEYS: Readonly<Record<string, string>> = {
  'auth.login_required': 'cli.errors.authLoginRequired',
  'shell.git_bash_not_found': 'cli.errors.shellGitBashNotFound',
};

/**
 * True for Kimi errors whether they crossed a process boundary (plain
 * `{ code, message }` payloads) or not (Error instances).
 */
export function isKimiError(error: unknown): error is KimiError {
  if (error instanceof KimiError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** Human title for an error code (falls back to the raw code). */
export function resolveErrorTitle(code: string): string {
  const titleKey = KIMI_ERROR_TITLE_KEYS[code];
  return titleKey === undefined ? code : t(titleKey);
}
