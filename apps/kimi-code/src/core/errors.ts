/**
 * Core error model for the v2 facade. Code values mirror the v1 wire codes
 * the TUI already matches on (see `packages/agent-core/src/errors/codes.ts`);
 * TODO(migrate): unify with a v2-native error registry once agent-core-v2
 * exposes one.
 */

import { isError2 } from '@moonshot-ai/agent-core-v2';

export const CoreErrorCodes = {
  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_ID_REQUIRED: 'session.id_required',
  SESSION_ID_EMPTY: 'session.id_empty',
  AGENT_NOT_FOUND: 'agent.not_found',
  TURN_AGENT_BUSY: 'turn.agent_busy',
  PLUGIN_NOT_FOUND: 'plugin.not_found',
  SESSION_INIT_FAILED: 'session.init_failed',
  // Facade-local: raised for capabilities the v2 surface declares but has not
  // implemented yet; not a v1 wire code.
  NOT_IMPLEMENTED: 'not_implemented',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',
  CONFIG_INVALID: 'config.invalid',
  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
} as const;

export class CoreError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'CoreError';
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * Recognizes errors that carry a v1-style string `code`: the facade's own
 * `CoreError` plus the `Error2` thrown by agent-core-v2 services. v2 reuses
 * the v1 code values verbatim (e.g. `session.not_found`), and the TUI matches
 * on those codes, so the guard must see through service errors instead of
 * forcing every call site into a separate fallback branch.
 *
 * v2 errors are identified via `isError2` (an `instanceof` guard), so this
 * does not depend on v2's error `name`. Errors thrown through the node-sdk
 * auth/catalog bridge are a different class reference (same `name`, different
 * `instanceof`), so a string-`code` + `name` fallback keeps recognizing them
 * until that bridge is migrated (TODO(migrate)).
 */
export function isCoreError(value: unknown): value is CoreError {
  if (value instanceof CoreError) return true;
  if (isError2(value)) return true;
  return (
    value instanceof Error &&
    typeof (value as { code?: unknown }).code === 'string' &&
    (value.name === 'KimiError' || value.name === 'Error2' || value.name === 'CoreError')
  );
}
