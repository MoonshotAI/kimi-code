/**
 * `IAuthSummaryService` — daemon-facing readiness probe (P2.1 D2).
 *
 * Single权威 readiness signal source:
 *   - `get()` produces the `AuthSummary` payload for `GET /v1/auth`.
 *   - `ensureReady(modelOverride?)` is the synchronous gate invoked by entry
 *     points that can't proceed without provider credentials — currently
 *     `PromptServiceImpl.submit`. It throws one of the four sentinel error
 *     classes below; daemon route layers map them to envelope codes
 *     `40110 / 40111 / 40112 / 40113`.
 *
 * Why centralized: the same "is there a usable provider + model + token?"
 * computation is needed by both the read probe and every write-side entry that
 * could surface 50001 "internal" today (PLAN背景 §1). Co-locating it keeps the
 * logic in one place + makes it cheap to add new gated entries (PATCH session
 * model, etc.).
 *
 * Status mapping note (P2.1 scope): we only return `'authenticated'` (token
 * cached) or `'unauthenticated'` (no token). The `'expired' / 'revoked'`
 * states require runtime OAuth introspection that lands in P2.7 + P2.9 —
 * P2.1's gate intentionally does NOT try to differentiate them.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { AuthSummary } from '@moonshot-ai/protocol';

export interface IAuthSummaryService {
  /**
   * Compute the current readiness snapshot. Cheap (one config read + one
   * cached-token lookup); safe to call on every `GET /v1/auth`.
   */
  get(): Promise<AuthSummary>;

  /**
   * Throw a sentinel auth error if the daemon can NOT currently serve a
   * prompt with `modelOverride` (or `config.defaultModel` if omitted).
   * Returns void on success.
   */
  ensureReady(modelOverride?: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAuthSummaryService = createDecorator<IAuthSummaryService>(
  'IAuthSummaryService',
);

/**
 * `40110 auth.provisioning_required` — daemon has zero provider configs.
 */
export class AuthProvisioningRequiredError extends Error {
  constructor() {
    super('no provider configured; complete onboarding via /login or POST /v1/providers');
    this.name = 'AuthProvisioningRequiredError';
  }
}

/**
 * `40111 auth.token_missing` — provider exists in config but its credential
 * (api_key or cached OAuth token) is missing.
 */
export class AuthTokenMissingError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} has no credential configured`);
    this.name = 'AuthTokenMissingError';
    this.providerId = providerId;
  }
}

/**
 * `40112 auth.token_unauthorized` — OAuth refresh returned 401; user has
 * revoked the grant. Not produced by P2.1's static gate (would require a
 * round-trip to the OAuth host); reserved for the reactive-refresh path in
 * P2.9.
 */
export class AuthTokenUnauthorizedError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} oauth grant revoked; re-login required`);
    this.name = 'AuthTokenUnauthorizedError';
    this.providerId = providerId;
  }
}

/**
 * `40113 auth.model_not_resolved` — the (default or requested) model alias
 * does not resolve to a configured provider. Two sub-cases:
 *   - no default model set at all (`modelId === undefined`)
 *   - alias missing or points at a non-existent provider
 */
export class AuthModelNotResolvedError extends Error {
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;
  constructor(modelId: string | undefined, providerId?: string) {
    super(
      modelId === undefined
        ? 'no default model configured'
        : `model ${modelId} does not resolve to a configured provider`,
    );
    this.name = 'AuthModelNotResolvedError';
    this.modelId = modelId;
    this.providerId = providerId;
  }
}
