/**
 * `authLegacy` domain (L7 edge adapter) — v1-compatible auth readiness summary.
 *
 * Implements the `GET /api/v1/auth` `AuthSummary` wire contract on top of the
 * native v2 services (`IProviderService`, `IConfigService`, `IOAuthService`).
 * The native `IAuthSummaryService` keeps serving `/api/v2` (`auth:summarize` /
 * `auth:ensureReady`) and is left untouched; this adapter exists only so v1
 * clients keep working against server-v2. Bound at App scope — it is a
 * stateless projector over the global provider / model / credential state.
 */

import type { AuthSummary } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAuthLegacyService {
  readonly _serviceBrand: undefined;

  get(): Promise<AuthSummary>;
}

export const IAuthLegacyService: ServiceIdentifier<IAuthLegacyService> =
  createDecorator<IAuthLegacyService>('authLegacyService');
