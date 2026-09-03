import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import type { AuthSummary } from './authLegacy';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '#/app/kosongConfig/configSection';
import { resolveModelForReady } from '#/kosong/model/modelAuth';
import type { ModelRecord } from '#/kosong/model/model';
import type { ProviderConfig } from '#/kosong/provider/provider';

import { IAuthLegacyService } from './authLegacy';

const MANAGED_PROVIDER_NAME = KIMI_CODE_PROVIDER_NAME;

export class AuthLegacyService implements IAuthLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  async get(): Promise<AuthSummary> {
    await this.config.ready;

    const snapshot = this.config.getAll();
    const providers = (snapshot[PROVIDERS_SECTION] ?? {}) as Readonly<
      Record<string, ProviderConfig>
    >;
    const models = (snapshot[MODELS_SECTION] ?? {}) as Readonly<Record<string, ModelRecord>>;
    const defaultModel = snapshot[DEFAULT_MODEL_SECTION] as string | undefined;
    const defaultProvider = snapshot[DEFAULT_PROVIDER_SECTION] as string | undefined;
    const providers_count = Object.keys(providers).length;
    const models_ready = resolveModelForReady(defaultModel, models, providers, defaultProvider).resolved;

    let managed_provider: AuthSummary['managed_provider'] = null;
    if (providers[MANAGED_PROVIDER_NAME] !== undefined) {
      const loggedIn = await this.managedLoggedIn();
      managed_provider = {
        name: MANAGED_PROVIDER_NAME,
        status: loggedIn ? 'authenticated' : 'unauthenticated',
      };
    }

    return { models_ready, providers_count, managed_provider };
  }

  private async managedLoggedIn(): Promise<boolean> {
    try {
      return (await this.oauth.status(MANAGED_PROVIDER_NAME)).loggedIn;
    } catch {
      return false;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IAuthLegacyService,
  AuthLegacyService,
  ScopeActivation.OnScopeCreated,
  'authLegacy',
);
