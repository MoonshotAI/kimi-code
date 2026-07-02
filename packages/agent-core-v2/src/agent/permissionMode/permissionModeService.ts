import type { PermissionMode } from '#/agent/permissionPolicy';
import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { OrderedHookSlot } from '#/hooks';
import { IAgentRecordService } from '#/agent/record';
import { registerPermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IAgentPermissionModeService } from './permissionMode';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'permission.set_mode': {
      mode: PermissionMode;
    };
  }
}

export class AgentPermissionModeService extends Disposable implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private currentMode: PermissionMode = 'manual';

  readonly hooks = {
    onChanged: new OrderedHookSlot<{
      mode: PermissionMode;
      previousMode: PermissionMode;
    }>(),
  };

  constructor(
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      record.define('permission.set_mode', {
        resume: (r) => {
          this.applyMode(r.mode);
        },
        toLive: (r) => ({ type: 'agent.status.updated', permission: r.mode }),
        toReplay: (r) => ({ type: 'permission_updated', mode: r.mode }),
      }),
    );
    this._register(
      registerPermissionModeInjection(dynamicInjector, this),
    );
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.record.append({ type: 'permission.set_mode', mode });
    this.applyMode(mode);
  }

  private applyMode(mode: PermissionMode): void {
    const previousMode = this.currentMode;
    this.currentMode = mode;
    void this.hooks.onChanged.run({ mode: this.currentMode, previousMode });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionModeService,
  AgentPermissionModeService,
  InstantiationType.Delayed,
  'permissionMode',
);
