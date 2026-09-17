import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { REMOTE_RUNTIME_FLAG_ID } from '#/runtime/flag';
import { LOCAL_RUNTIME_ID, type Runtime, type RuntimeBinding } from '#/runtime/runtime';
import { RuntimeError, runtimeStatusAllows } from '#/runtime/runtimeRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from './runtimeBinding';
import { RuntimeSetBinding, runtimeBindingKey } from './runtimeBindingOps';

export const agentRuntimeBindingKey = defineState<RuntimeBinding>('runtime.binding', () => ({ workspaceId: '', runtimeId: LOCAL_RUNTIME_ID }));

export const RUNTIME_ENVIRONMENT_REMINDER_VARIANT = 'runtime_binding';

function environmentReminderText(binding: RuntimeBinding, environment: HostEnvironmentInfo, fallbackCwd: string): string {
  return [
    `The active runtime environment is now "${binding.runtimeId}":`,
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

export class AgentRuntimeBindingService implements IAgentRuntimeBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<RuntimeBinding>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly restoreHook: IDisposable;
  private readonly turnEndSubscription: IDisposable;
  private pendingWorkDir: string | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentRuntimeBindingSeed private readonly seed: IAgentRuntimeBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
    @ref(IAgentLoopService) private readonly loop: LiveRef<IAgentLoopService>,
    @IFlagService private readonly flags: IFlagService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @ILogService private readonly log: ILogService,
  ) {
    this.state.contributeState(agentRuntimeBindingKey);
    this.state.contributeState(runtimeBindingKey);
    const initial = this.state.get(runtimeBindingKey) ?? seed.binding;
    this.assertSessionWorkspace(initial);
    this.state.set(agentRuntimeBindingKey, initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-runtime-binding', async (_ctx, next) => {
      const replayed = this.state.get(runtimeBindingKey);
      if (replayed !== undefined) {
        this.assertSessionWorkspace(replayed);
        this.state.set(agentRuntimeBindingKey, replayed);
        this.applySessionWorkDir(replayed);
        if (this.isSeedRoundTrip(replayed)) {
          this.emitEnvironmentReminder(replayed);
        }
        this.reconnectRestoredBinding(replayed);
      } else {
        const persisted = await this.peekPersistedBinding();
        if (persisted !== undefined && persisted.runtimeId !== LOCAL_RUNTIME_ID) {
          this.state.set(agentRuntimeBindingKey, persisted);
          await this.dispatcher.dispatch(
            new RuntimeSetBinding({ ...persisted, agentId: this.scopeContext.agentId }),
          );
          this.applySessionWorkDir(persisted);
          this.reconnectRestoredBinding(persisted);
        } else {
          await this.dispatcher.dispatch(
            new RuntimeSetBinding({ ...this.current, agentId: this.scopeContext.agentId }),
          );
          this.applySessionWorkDir(this.current);
          if (this.current.runtimeId !== LOCAL_RUNTIME_ID) {
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

  private assertSessionWorkspace(binding: RuntimeBinding): void {
    if (binding.workspaceId !== this.session.workspaceId) {
      throw new RuntimeError(
        'runtime.not_found',
        `runtime binding workspace ${binding.workspaceId} does not match session workspace ${this.session.workspaceId}`,
      );
    }
  }

  private isSeedRoundTrip(binding: RuntimeBinding): boolean {
    const seed = this.seed.binding;
    return (
      binding.runtimeId !== LOCAL_RUNTIME_ID &&
      binding.workspaceId === seed.workspaceId &&
      binding.runtimeId === seed.runtimeId &&
      binding.cwd === seed.cwd
    );
  }

  private async peekPersistedBinding(): Promise<RuntimeBinding | undefined> {
    try {
      let binding: RuntimeBinding | undefined;
      for await (const record of this.appendLog.read<WireRecord>(this.scopeContext.scope(), AGENT_WIRE_RECORD_KEY)) {
        if (record.type === RuntimeSetBinding.type && typeof record['runtimeId'] === 'string') {
          binding = {
            workspaceId: this.session.workspaceId,
            runtimeId: record['runtimeId'],
            cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
          };
        }
      }
      return binding;
    } catch {
      return undefined;
    }
  }

  private reconnectRestoredBinding(binding: RuntimeBinding): void {
    if (this.scopeContext.agentId === MAIN_AGENT_ID) return;
    if (binding.runtimeId === LOCAL_RUNTIME_ID) return;
    if (!this.flags.enabled(REMOTE_RUNTIME_FLAG_ID)) return;
    let runtime: Runtime;
    try {
      runtime = this.resolver.inspect(binding);
    } catch {
      return;
    }
    if (runtimeStatusAllows(runtime, ['fs', 'process'])) return;
    if (typeof runtime.connect !== 'function') return;
    try {
      if (binding.cwd !== undefined) {
        void runtime.reroot?.(binding.cwd)?.catch((error: unknown) => {
          this.log.warn(`background reroot of restored runtime ${binding.runtimeId} failed`, { error });
        });
      }
      void runtime.connect().catch((error: unknown) => {
        this.log.warn(`background reconnect of restored runtime ${binding.runtimeId} failed`, { error });
      });
    } catch (error) {
      this.log.warn(`background reconnect of restored runtime ${binding.runtimeId} failed`, { error });
    }
  }

  private assertSwitchAllowed(): void {
    const busy = this.loop.current?.snapshot().turn?.activeToolCalls.length ?? 0;
    if (busy > 0) {
      throw new RuntimeError(
        'runtime.conflict',
        `cannot switch runtime while ${busy} tool call(s) are executing or pending approval; retry at the next turn boundary`,
      );
    }
  }

  private applySessionWorkDir(binding: RuntimeBinding): void {
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

  get current(): RuntimeBinding {
    return this.state.get(agentRuntimeBindingKey);
  }

  get(): RuntimeBinding {
    return this.current;
  }

  set(binding: RuntimeBinding): RuntimeBinding {
    this.assertSessionWorkspace(binding);
    this.assertSwitchAllowed();
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    return this.commit(binding);
  }

  async connectAndSwitch(runtimeId: string, cwd?: string): Promise<RuntimeBinding> {
    const binding: RuntimeBinding = { workspaceId: this.session.workspaceId, runtimeId, cwd };
    this.assertSessionWorkspace(binding);
    this.assertSwitchAllowed();
    if (runtimeId !== LOCAL_RUNTIME_ID && cwd === undefined) {
      throw new RuntimeError('runtime.invalid_cwd', `binding runtime ${runtimeId} requires a cwd`);
    }
    const inspected = this.resolver.inspect(binding);
    if (!runtimeStatusAllows(inspected, [])) {
      if (typeof inspected.connect !== 'function') {
        throw new RuntimeError('runtime.unavailable', `runtime ${runtimeId} is ${inspected.status}`);
      }
      await inspected.connect();
    }
    const lease = this.resolver.acquire(binding, []);
    try {
      if (runtimeId !== LOCAL_RUNTIME_ID && cwd !== undefined) {
        const fs = lease.runtime.fs;
        if (fs === undefined) {
          throw new RuntimeError('runtime.capability_unavailable', `runtime ${runtimeId} does not provide fs`);
        }
        const stat = await fs.stat(cwd).catch((error: unknown) => {
          throw new RuntimeError(
            'runtime.invalid_cwd',
            `cwd ${cwd} is not readable on runtime ${runtimeId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        if (!stat.isDirectory) {
          throw new RuntimeError('runtime.invalid_cwd', `cwd ${cwd} is not a directory on runtime ${runtimeId}`);
        }
      }
    } finally {
      lease.dispose();
    }
    if (runtimeId !== LOCAL_RUNTIME_ID && cwd !== undefined) {
      await this.resolver.inspect(binding).reroot?.(cwd);
    }
    return this.commit(binding);
  }

  private commit(binding: RuntimeBinding): RuntimeBinding {
    const previous = this.current;
    if (
      binding.workspaceId === previous.workspaceId &&
      binding.runtimeId === previous.runtimeId &&
      binding.cwd === previous.cwd
    ) {
      return previous;
    }
    const next = { workspaceId: binding.workspaceId, runtimeId: binding.runtimeId, cwd: binding.cwd };
    void this.dispatcher.dispatch(
      new RuntimeSetBinding({ ...next, agentId: this.scopeContext.agentId }),
    );
    this.state.set(agentRuntimeBindingKey, next);
    this.applySessionWorkDir(next);
    if (this.machineIdentityChanged(previous, next)) {
      this.emitEnvironmentReminder(next);
    }
    this.changeEmitter.fire(next);
    return next;
  }

  private machineIdentityChanged(previous: RuntimeBinding, next: RuntimeBinding): boolean {
    if (
      previous.runtimeId !== LOCAL_RUNTIME_ID &&
      next.runtimeId !== LOCAL_RUNTIME_ID &&
      previous.runtimeId !== next.runtimeId
    ) {
      return true;
    }
    try {
      return !hostEnvironmentEquals(
        this.resolver.inspect(previous).environment,
        this.resolver.inspect(next).environment,
      );
    } catch {
      return true;
    }
  }

  private emitEnvironmentReminder(binding: RuntimeBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    if (!this.flags.enabled(REMOTE_RUNTIME_FLAG_ID)) return;
    let environment: HostEnvironmentInfo;
    try {
      environment = this.resolver.inspect(binding).environment;
    } catch {
      return;
    }
    this.reminder.notify(environmentReminderText(binding, environment, this.session.cwd), {
      variant: RUNTIME_ENVIRONMENT_REMINDER_VARIANT,
    });
  }

  switch(runtimeId: string, cwd?: string): RuntimeBinding {
    return this.set({ workspaceId: this.session.workspaceId, runtimeId, cwd });
  }

  dispose(): void {
    this.turnEndSubscription.dispose();
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentRuntimeBindingService, AgentRuntimeBindingService, ScopeActivation.OnScopeCreated, 'agentRuntimeBinding');
