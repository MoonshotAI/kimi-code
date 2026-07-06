/**
 * `permissionMode` domain (L3) — `IAgentPermissionModeService` implementation.
 *
 * Holds the agent's permission mode (`manual` / `auto`) in the `wire`
 * `PermissionModeModel`, mutating it only through the `permission.set_mode` Op
 * (`wire.dispatch(setMode({ mode }))`) and reading it through `wire.getModel`.
 * The `onChanged` hook is driven by a `wire.subscribe` on that model (firing
 * only on actual changes), and the mode-aware reminder is registered through
 * `contextInjector`. Bound at Agent scope.
 */

import type { PermissionMode } from '#/agent/permissionPolicy';
import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { OrderedHookSlot } from '#/hooks';
import { registerPermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IAgentWireService, type IWireService } from '#/wire';
import { IAgentPermissionModeService } from './permissionMode';
import { PermissionModeModel, setMode } from './permissionModeOps';

export class AgentPermissionModeService extends Disposable implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = {
    onChanged: new OrderedHookSlot<{
      mode: PermissionMode;
      previousMode: PermissionMode;
    }>(),
  };

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      wire.subscribe(PermissionModeModel, (mode, previousMode) => {
        if (mode === previousMode) return;
        void this.hooks.onChanged.run({ mode, previousMode });
      }),
    );
    this._register(registerPermissionModeInjection(dynamicInjector, this));
  }

  get mode(): PermissionMode {
    return this.wire.getModel(PermissionModeModel);
  }

  setMode(mode: PermissionMode): void {
    this.wire.dispatch(setMode({ mode }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionModeService,
  AgentPermissionModeService,
  InstantiationType.Delayed,
  'permissionMode',
);
