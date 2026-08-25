import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { permissionRulesAgentRuntimeProvider } from './permissionRulesAgentRuntime';

export class PermissionRulesFeature extends Feature {
  static override readonly name = 'permissionRules';

  constructor() {
    super();
    this.contributeAgentRuntime(permissionRulesAgentRuntimeProvider);
  }
}

registerFeature(PermissionRulesFeature);
