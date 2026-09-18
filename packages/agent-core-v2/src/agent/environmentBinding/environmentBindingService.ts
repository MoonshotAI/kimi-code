import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ISessionEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { LOCAL_ENVIRONMENT_ID, type Environment, type EnvironmentBinding } from '#/environment/environment';
import { EnvironmentError, environmentStatusAllows } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IEnvironmentResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentEnvironmentBindingSeed, IAgentEnvironmentBindingService } from './environmentBinding';
import { EnvironmentSetBinding, environmentBindingKey } from './environmentBindingOps';

export const agentEnvironmentBindingKey = defineState<EnvironmentBinding>('environment.binding', () => ({ workspaceId: '', environmentId: LOCAL_ENVIRONMENT_ID }));

export const ENVIRONMENT_BINDING_REMINDER_VARIANT = 'environment_binding';

function environmentReminderText(binding: EnvironmentBinding, environment: HostEnvironmentInfo, fallbackCwd: string): string {
  return [
    `The active environment is now "${binding.environmentId}":`,
    `${environment.osKind} ${environment.osVersion} ${environment.osArch},`,
    `shell ${environment.shellName} (${environment.shellPath}),`,
    `working directory ${binding.cwd ?? fallbackCwd}.`,
    'Tool calls execute in this environment.',
  ].join(' ');
}

function hostEnvironmentEquals(left: HostEnvironmentInfo, right: HostEnvironmentInfo): boolean {
  return (
    left.osKind === right.osKind &&
    left.osArch === right.osArch &&
    left.osVersion === right.osVersion &&
    left.shellName === right.shellName &&
    left.shellPath === right.shellPath &&
    left.pathClass === right.pathClass &&
    left.homeDir === right.homeDir
  );
}

export class AgentEnvironmentBindingService implements IAgentEnvironmentBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<EnvironmentBinding>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly restoreHook: IDisposable;
  private readonly turnEndSubscription: IDisposable;
  private pendingWorkDir: string | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentEnvironmentBindingSeed private readonly seed: IAgentEnvironmentBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IEnvironmentResolver private readonly resolver: IEnvironmentResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
    @ref(IAgentLoopService) private readonly loop: LiveRef<IAgentLoopService>,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @ILogService private readonly log: ILogService,
  ) {
    this.state.contributeState(agentEnvironmentBindingKey);
    this.state.contributeState(environmentBindingKey);
    const initial = this.state.get(environmentBindingKey) ?? seed.binding;
    this.assertSessionWorkspace(initial);
    this.state.set(agentEnvironmentBindingKey, initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-environment-binding', async (_ctx, next) => {
      const replayed = this.state.get(environmentBindingKey);
      if (replayed !== undefined) {
        this.assertSessionWorkspace(replayed);
        this.state.set(agentEnvironmentBindingKey, replayed);
        this.applySessionWorkDir(replayed);
        if (this.isSeedRoundTrip(replayed)) {
          this.emitEnvironmentReminder(replayed);
        }
        this.reconnectRestoredBinding(replayed);
      } else {
        const persisted = await this.peekPersistedBinding();
        if (persisted !== undefined && persisted.environmentId !== LOCAL_ENVIRONMENT_ID) {
          this.state.set(agentEnvironmentBindingKey, persisted);
          await this.dispatcher.dispatch(
            new EnvironmentSetBinding({ ...persisted, agentId: this.scopeContext.agentId }),
          );
          this.applySessionWorkDir(persisted);
          this.reconnectRestoredBinding(persisted);
        } else {
          await this.dispatcher.dispatch(
            new EnvironmentSetBinding({ ...this.current, agentId: this.scopeContext.agentId }),
          );
          this.applySessionWorkDir(this.current);
          if (this.current.environmentId !== LOCAL_ENVIRONMENT_ID) {
            this.emitEnvironmentReminder(this.current);
          }
        }
      }
      await next();
    });
    this.turnEndSubscription = this.eventBus.subscribe(TurnEnded, (event) => {
      if (event.agentId !== this.scopeContext.agentId) return;
      this.flushPendingWorkDir();
    });
  }

  private assertSessionWorkspace(binding: EnvironmentBinding): void {
    if (binding.workspaceId !== this.session.workspaceId) {
      throw new EnvironmentError(
        'environment.not_found',
        `environment binding workspace ${binding.workspaceId} does not match session workspace ${this.session.workspaceId}`,
      );
    }
  }

  private isSeedRoundTrip(binding: EnvironmentBinding): boolean {
    const seed = this.seed.binding;
    return (
      binding.environmentId !== LOCAL_ENVIRONMENT_ID &&
      binding.workspaceId === seed.workspaceId &&
      binding.environmentId === seed.environmentId &&
      binding.cwd === seed.cwd
    );
  }

  private async peekPersistedBinding(): Promise<EnvironmentBinding | undefined> {
    try {
      let binding: EnvironmentBinding | undefined;
      for await (const record of this.appendLog.read<WireRecord>(this.scopeContext.scope(), AGENT_WIRE_RECORD_KEY)) {
        if (record.type === EnvironmentSetBinding.type && typeof record['environmentId'] === 'string') {
          binding = {
            workspaceId: this.session.workspaceId,
            environmentId: record['environmentId'],
            cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
          };
        }
      }
      return binding;
    } catch {
      return undefined;
    }
  }

  private reconnectRestoredBinding(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId === MAIN_AGENT_ID) return;
    if (binding.environmentId === LOCAL_ENVIRONMENT_ID) return;
    let environment: Environment;
    try {
      environment = this.resolver.inspect(binding);
    } catch {
      return;
    }
    if (environmentStatusAllows(environment, ['fs', 'process'])) return;
    if (typeof environment.connect !== 'function') return;
    try {
      if (binding.cwd !== undefined) {
        void environment.reroot?.(binding.cwd)?.catch((error: unknown) => {
          this.log.warn(`background reroot of restored environment ${binding.environmentId} failed`, { error });
        });
      }
      void environment.connect().catch((error: unknown) => {
        this.log.warn(`background reconnect of restored environment ${binding.environmentId} failed`, { error });
      });
    } catch (error) {
      this.log.warn(`background reconnect of restored environment ${binding.environmentId} failed`, { error });
    }
  }

  private assertSwitchAllowed(): void {
    const busy = this.loop.current?.snapshot().turn?.activeToolCalls.length ?? 0;
    if (busy > 0) {
      throw new EnvironmentError(
        'environment.conflict',
        `cannot switch environment while ${busy} tool call(s) are executing or pending approval; retry at the next turn boundary`,
      );
    }
  }

  private applySessionWorkDir(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    const workDir = binding.cwd ?? this.session.cwd;
    if (this.loop.current?.snapshot().turn !== undefined) {
      this.pendingWorkDir = workDir;
      return;
    }
    this.workspaceContext.setWorkDir(workDir);
  }

  private flushPendingWorkDir(): void {
    const pending = this.pendingWorkDir;
    if (pending === undefined) return;
    this.pendingWorkDir = undefined;
    this.workspaceContext.setWorkDir(pending);
  }

  get current(): EnvironmentBinding {
    return this.state.get(agentEnvironmentBindingKey);
  }

  get(): EnvironmentBinding {
    return this.current;
  }

  set(binding: EnvironmentBinding): EnvironmentBinding {
    this.assertSessionWorkspace(binding);
    this.assertSwitchAllowed();
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    return this.commit(binding);
  }

  async connectAndSwitch(environmentId: string, cwd?: string): Promise<EnvironmentBinding> {
    const binding: EnvironmentBinding = { workspaceId: this.session.workspaceId, environmentId, cwd };
    this.assertSessionWorkspace(binding);
    this.assertSwitchAllowed();
    if (environmentId !== LOCAL_ENVIRONMENT_ID && cwd === undefined) {
      throw new EnvironmentError('environment.invalid_cwd', `binding environment ${environmentId} requires a cwd`);
    }
    const inspected = this.resolver.inspect(binding);
    if (!environmentStatusAllows(inspected, [])) {
      if (typeof inspected.connect !== 'function') {
        throw new EnvironmentError('environment.unavailable', `environment ${environmentId} is ${inspected.status}`);
      }
      await inspected.connect();
    }
    const lease = this.resolver.acquire(binding, []);
    try {
      if (environmentId !== LOCAL_ENVIRONMENT_ID && cwd !== undefined) {
        const fs = lease.environment.fs;
        if (fs === undefined) {
          throw new EnvironmentError('environment.capability_unavailable', `environment ${environmentId} does not provide fs`);
        }
        const stat = await fs.stat(cwd).catch((error: unknown) => {
          throw new EnvironmentError(
            'environment.invalid_cwd',
            `cwd ${cwd} is not readable on environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        if (!stat.isDirectory) {
          throw new EnvironmentError('environment.invalid_cwd', `cwd ${cwd} is not a directory on environment ${environmentId}`);
        }
      }
    } finally {
      lease.dispose();
    }
    if (environmentId !== LOCAL_ENVIRONMENT_ID && cwd !== undefined) {
      await this.resolver.inspect(binding).reroot?.(cwd);
    }
    return this.commit(binding);
  }

  private commit(binding: EnvironmentBinding): EnvironmentBinding {
    const previous = this.current;
    if (
      binding.workspaceId === previous.workspaceId &&
      binding.environmentId === previous.environmentId &&
      binding.cwd === previous.cwd
    ) {
      return previous;
    }
    const next = { workspaceId: binding.workspaceId, environmentId: binding.environmentId, cwd: binding.cwd };
    void this.dispatcher.dispatch(
      new EnvironmentSetBinding({ ...next, agentId: this.scopeContext.agentId }),
    );
    this.state.set(agentEnvironmentBindingKey, next);
    this.applySessionWorkDir(next);
    if (this.machineIdentityChanged(previous, next)) {
      this.emitEnvironmentReminder(next);
    }
    this.changeEmitter.fire(next);
    return next;
  }

  private machineIdentityChanged(previous: EnvironmentBinding, next: EnvironmentBinding): boolean {
    if (
      previous.environmentId !== LOCAL_ENVIRONMENT_ID &&
      next.environmentId !== LOCAL_ENVIRONMENT_ID &&
      previous.environmentId !== next.environmentId
    ) {
      return true;
    }
    try {
      return !hostEnvironmentEquals(
        this.resolver.inspect(previous).host,
        this.resolver.inspect(next).host,
      );
    } catch {
      return true;
    }
  }

  private emitEnvironmentReminder(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    let environment: HostEnvironmentInfo;
    try {
      environment = this.resolver.inspect(binding).host;
    } catch {
      return;
    }
    this.reminder.notify(environmentReminderText(binding, environment, this.session.cwd), {
      variant: ENVIRONMENT_BINDING_REMINDER_VARIANT,
    });
  }

  switch(environmentId: string, cwd?: string): EnvironmentBinding {
    return this.set({ workspaceId: this.session.workspaceId, environmentId, cwd });
  }

  dispose(): void {
    this.turnEndSubscription.dispose();
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentEnvironmentBindingService, AgentEnvironmentBindingService, ScopeActivation.OnScopeCreated, 'agentEnvironmentBinding');
