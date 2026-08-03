/**
 * `authLegacy` domain — `IAuthLegacyService` implementation.
 *
 * Stateless App-scope projector: reads the configured providers through
 * `provider`, the global default-model selection through `model` (the
 * kosong registry is the runtime source of truth; config is only its
 * persistence), and the managed OAuth provider's cached-token state through
 * `auth`, then assembles the v1 `AuthSummary`. The computation mirrors v1's
 * `AuthSummaryService.get()` so the `/api/v1/auth` envelope is
 * byte-compatible. No business logic is duplicated; the native
 * `IAuthSummaryService` (which serves `/api/v2`) is not involved.
 */

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import type { AuthSummary } from './authLegacy';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';

import { IAuthLegacyService } from './authLegacy';

const MANAGED_PROVIDER_NAME = KIMI_CODE_PROVIDER_NAME;

export class AuthLegacyService implements IAuthLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providerService: IProviderService,
    @IModelService private readonly modelService: IModelService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  async get(): Promise<AuthSummary> {
    // The kosong registries become ready once the persistence bridge has
    // hydrated them from config — that is the readiness this projection needs.
    await this.modelService.ready;

    const providers = this.providerService.list();
    const providers_count = Object.keys(providers).length;
    const default_model = nonEmpty(this.modelService.getDefaultModel());

    let managed_provider: AuthSummary['managed_provider'] = null;
    if (providers[MANAGED_PROVIDER_NAME] !== undefined) {
      const loggedIn = await this.managedLoggedIn();
      managed_provider = {
        name: MANAGED_PROVIDER_NAME,
        status: loggedIn ? 'authenticated' : 'unauthenticated',
      };
    }

    const ready =
      providers_count >= 1 &&
      default_model !== null &&
      (managed_provider === null || managed_provider.status !== 'revoked');

    return { ready, providers_count, default_model, managed_provider };
  }

  private async managedLoggedIn(): Promise<boolean> {
    try {
      return (await this.oauth.status(MANAGED_PROVIDER_NAME)).loggedIn;
    } catch {
      return false;
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IAuthLegacyService,
  AuthLegacyService,
  InstantiationType.Eager,
  'authLegacy',
);
