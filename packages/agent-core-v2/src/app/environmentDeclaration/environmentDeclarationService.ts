import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

import { IEnvironmentDeclarationService } from './environmentDeclaration';

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {}

  async declarations(): Promise<EnvironmentDeclarationSet | undefined> {
    try {
      return await resolveWorkspaceEnvironmentDeclarations(this.config);
    } catch (error) {
      this.log.warn('remote environment declaration resolution failed', { error });
      return undefined;
    }
  }
}

registerScopedService(LifecycleScope.App, IEnvironmentDeclarationService, EnvironmentDeclarationService, ScopeActivation.OnScopeCreated, 'environmentDeclaration');
