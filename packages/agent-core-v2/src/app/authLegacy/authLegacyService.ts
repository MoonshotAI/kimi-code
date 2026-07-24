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

import {
  KIMI_CODE_PROVIDER_NAME,
  OPENAI_CODEX_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import type { AuthSummary } from './authLegacy';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { effectiveModelConfig } from '#/kosong/model/modelAuth';
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
    const activeProvider =
      default_model === null
        ? undefined
        : providerForModel(
            this.modelService.get(default_model),
            this.providerService.getDefaultProvider(),
          );

    let managed_provider: AuthSummary['managed_provider'] = null;
    const oauth_providers: AuthSummary['oauth_providers'] = [];
    const oauthProviderNames = new Set([
      MANAGED_PROVIDER_NAME,
      OPENAI_CODEX_PROVIDER_NAME,
      ...Object.entries(providers)
        .filter(([, provider]) => provider.oauth !== undefined)
        .map(([name]) => name),
    ]);
    for (const name of oauthProviderNames) {
      const loggedIn = await this.loggedIn(name);
      if (providers[name]?.oauth === undefined && !loggedIn) continue;
      const status = loggedIn ? 'authenticated' : 'unauthenticated';
      const entitlement_status =
        name === MANAGED_PROVIDER_NAME &&
        loggedIn &&
        providers[name]?.oauth === undefined
          ? await this.entitlementStatus(name)
          : undefined;
      oauth_providers.push({
        name,
        status,
        active: name === activeProvider,
        entitlement_status,
      });
      if (name === MANAGED_PROVIDER_NAME) {
        managed_provider = { name, status };
      }
    }

    const activeOAuthProvider = oauth_providers.find((provider) => provider.active);
    const ready =
      providers_count >= 1 &&
      default_model !== null &&
      (activeOAuthProvider === undefined || activeOAuthProvider.status === 'authenticated');

    return { ready, providers_count, default_model, managed_provider, oauth_providers };
  }

  private async loggedIn(provider: string): Promise<boolean> {
    try {
      return (await this.oauth.status(provider)).loggedIn;
    } catch {
      return false;
    }
  }

  private async entitlementStatus(
    provider: string,
  ): Promise<'membership_required' | undefined> {
    try {
      return await this.oauth.entitlementStatus(provider);
    } catch {
      return undefined;
    }
  }
}

function providerForModel(
  model: ModelRecord | undefined,
  defaultProvider: string | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  const effective = effectiveModelConfig(model);
  return effective.providerId ?? effective.provider ?? defaultProvider;
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
