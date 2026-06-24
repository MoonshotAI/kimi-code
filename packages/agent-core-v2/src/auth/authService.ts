/**
 * `auth` domain (cross-cutting) — `IOAuthService` / `IAuthSummaryService`
 * implementation.
 *
 * Tracks login state per provider in-memory. The real OAuth flow is wired in
 * a later step.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/config/config';
import { IEnvironmentService } from '#/environment/environment';
import { ITelemetryService } from '#/telemetry/telemetry';

import { type AuthStatus, IAuthSummaryService, IOAuthService } from './auth';

export class OAuthService implements IOAuthService {
  declare readonly _serviceBrand: undefined;
  private readonly loggedIn = new Set<string>();

  constructor(
    @IConfigService _config: IConfigService,
    @IEnvironmentService _env: IEnvironmentService,
    @ITelemetryService _telemetry: ITelemetryService,
  ) {}

  login(provider: string): Promise<void> {
    this.loggedIn.add(provider);
    return Promise.resolve();
  }
  logout(provider: string): Promise<void> {
    this.loggedIn.delete(provider);
    return Promise.resolve();
  }
  status(): Promise<AuthStatus> {
    const [provider] = this.loggedIn;
    return Promise.resolve(
      provider === undefined ? { loggedIn: false } : { loggedIn: true, provider },
    );
  }
}

export class AuthSummaryService implements IAuthSummaryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService _config: IConfigService,
    @ITelemetryService _telemetry: ITelemetryService,
    private readonly oauth?: OAuthService,
  ) {}

  summarize(): Promise<readonly AuthStatus[]> {
    if (this.oauth === undefined) return Promise.resolve([]);
    return this.oauth.status().then((s) => [s]);
  }
}

registerScopedService(LifecycleScope.Core, IOAuthService, OAuthService, InstantiationType.Delayed, 'auth');
registerScopedService(LifecycleScope.Core, IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed, 'auth');
