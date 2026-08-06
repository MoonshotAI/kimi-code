/**
 * `permissionMode` domain — `IAgentPermissionModeService` implementation.
 *
 * Holds the agent's permission mode (`manual` / `yolo` / `auto`) in the `wire`
 * `PermissionModeModel`, mutating it only through the `permission.set_mode` Op
 * (`wire.dispatch(setMode({ mode }))`) and reading it through `wire.getModel`.
 * `setMode` emits `onDidChangeMode` after an actual change, and mode-aware
 * reminders are registered through the permission-mode injection helper. Bound
 * at Agent scope.
 */

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IWireService } from '#/wire/wire';
import { IAgentPermissionModeService, type PermissionModeChangedContext } from './permissionMode';
import {
  PermissionModeConfiguredModel,
  PermissionModeModel,
  setMode,
} from './permissionModeOps';

export class AgentPermissionModeService extends Service implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<PermissionModeChangedContext>());
  readonly onDidChangeMode: Event<PermissionModeChangedContext> = this._onDidChangeMode.event;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this._register(instantiation.createInstance(PermissionModeInjection, this));
  }

  get mode(): PermissionMode {
    return this.wire.getModel(PermissionModeModel);
  }

  setMode(mode: PermissionMode): void {
    const previousMode = this.mode;
    const changed = mode !== previousMode;
    if (!changed && this.wire.getModel(PermissionModeConfiguredModel)) return;
    this.wire.dispatch(setMode({ mode }));
    if (changed) this._onDidChangeMode.fire({ mode, previousMode });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionModeService,
  AgentPermissionModeService,
  ScopeActivation.OnScopeCreated,
  'permissionMode',
);
