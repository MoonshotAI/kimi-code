import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { SessionPermissionModeService } from '#/session/permissionMode/sessionPermissionModeService';

import { permissionModeAgentRuntimeProvider } from './permissionModeAgentRuntime';

export class PermissionModeFeature extends Feature {
  static override readonly name = 'permissionMode';

  constructor() {
    super();
    this.contributeAgentRuntime(permissionModeAgentRuntimeProvider);
    this.contributeService(
      LifecycleScope.Session,
      ISessionPermissionModeService,
      SessionPermissionModeService,
    );
  }
}

registerFeature(PermissionModeFeature);
