/**
 * `permissionMode` domain (L3) — `IAgentPermissionModeService` implementation.
 *
 * Holds the agent's permission mode (`manual` / `auto`) in the `wire`
 * `PermissionModeModel`, mutating it only through the `permission.set_mode` Op
 * (`wire.dispatch(setMode({ mode }))`) and reading it through `wire.getModel`.
 * The `onDidChangeMode` event is driven by a `wire.subscribe` on that model
 * (firing only on actual changes), and mode-aware reminders are registered
 * through the permission-mode injection helper. Bound at Agent scope.
 */

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import { IAgentPermissionModeService, type PermissionModeChangedContext } from './permissionMode';
import { PermissionModeModel, setMode } from './permissionModeOps';

export class AgentPermissionModeService extends Disposable implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<PermissionModeChangedContext>());
  readonly onDidChangeMode: Event<PermissionModeChangedContext> = this._onDidChangeMode.event;

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this._register(
      wire.subscribe(PermissionModeModel, (mode, previousMode) => {
        if (mode === previousMode) return;
        this._onDidChangeMode.fire({ mode, previousMode });
      }),
    );
    this._register(instantiation.createInstance(PermissionModeInjection, this));
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
