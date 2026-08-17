/**
 * `permissionMode` domain — `IAgentPermissionModeService` implementation.
 *
 * Holds the agent's permission mode (`manual` / `yolo` / `auto`) in the
 * `permissionModeKey` state, mutating it only through the durable
 * `PermissionSetMode` event
 * (`dispatcher.dispatch(new PermissionSetMode({ mode }))`) and reading it
 * through `dispatcher.getState`.
 * `setMode` emits `onDidChangeMode` after an actual change, and mode-aware
 * reminders are registered through the permission-mode injection helper.
 * `setModeAndBroadcast` is the user-facing entry: on top of `setMode` it
 * broadcasts the mode to every agent of the session through `agentLifecycle`
 * (main agent only) and tracks the `yolo_toggle` / `afk_toggle` transitions
 * through `telemetry`. Bound at Agent scope.
 */

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentPermissionModeService, type PermissionModeChangedContext } from './permissionMode';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
  PermissionSetMode,
} from './permissionModeOps';

export class AgentPermissionModeService extends Service implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<PermissionModeChangedContext>());
  readonly onDidChangeMode: Event<PermissionModeChangedContext> = this._onDidChangeMode.event;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(permissionModeKey);
    this.agentState.contributeState(permissionModeConfiguredKey);
    this._register(instantiation.createInstance(PermissionModeInjection, this));
  }

  get mode(): PermissionMode {
    return this.agentState.get(permissionModeKey);
  }

  setMode(mode: PermissionMode): void {
    const previousMode = this.mode;
    const changed = mode !== previousMode;
    if (!changed && this.agentState.get(permissionModeConfiguredKey)) return;
    void this.dispatcher.dispatch(new PermissionSetMode({ mode }));
    if (changed) this._onDidChangeMode.fire({ mode, previousMode });
  }

  setModeAndBroadcast(mode: PermissionMode): void {
    const wasYolo = this.mode === 'yolo';
    const wasAuto = this.mode === 'auto';
    this.setMode(mode);
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      this.agentLifecycle.broadcastPermissionMode(mode);
    }
    const yoloEnabled = this.mode === 'yolo';
    if (yoloEnabled !== wasYolo) {
      this.telemetry.track2('yolo_toggle', { enabled: yoloEnabled });
    }
    const afkEnabled = this.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track2('afk_toggle', { enabled: afkEnabled });
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionModeService,
  AgentPermissionModeService,
  ScopeActivation.OnScopeCreated,
  'permissionMode',
);
