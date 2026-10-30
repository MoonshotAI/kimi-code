import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IConfigService } from '#/app/config/config';

import { IAgentPermissionRulesService } from './permissionRules';
import { PERMISSION_SECTION, type PermissionConfig } from './configSection';

export interface IPermissionRulesConfigBridge {
  readonly _serviceBrand: undefined;
}

export const IPermissionRulesConfigBridge: ServiceIdentifier<IPermissionRulesConfigBridge> =
  createDecorator<IPermissionRulesConfigBridge>('permissionRulesConfigBridge');

export class PermissionRulesConfigBridge extends Disposable implements IPermissionRulesConfigBridge {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IAgentPermissionRulesService rules: IAgentPermissionRulesService,
    @IAgentConversationUndoParticipantRegistry undoParticipants: IAgentConversationUndoParticipantRegistry,
  ) {
    super();
    const configuredRules = config.get<PermissionConfig>(PERMISSION_SECTION)?.rules ?? [];
    rules.addRules(configuredRules);
    this._register(
      undoParticipants.register({
        id: 'permissionRules.config',
        reconcileAfterUndo: async () => {
          rules.addRules(configuredRules);
        },
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IPermissionRulesConfigBridge,
  PermissionRulesConfigBridge,
  ScopeActivation.OnScopeCreated,
  'permissionRules',
);
