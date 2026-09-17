import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Emitter } from '#/_base/event';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { REMOTE_RUNTIME_FLAG_ID } from '#/runtime/flag';
import { LOCAL_RUNTIME_ID, type RuntimeBinding } from '#/runtime/runtime';
import { RuntimeError, runtimeStatusAllows } from '#/runtime/runtimeRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
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
    @IAgentRuntimeBindingSeed seed: IAgentRuntimeBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
    @ref(IAgentLoopService) private readonly loop: LiveRef<IAgentLoopService>,
    @IFlagService private readonly flags: IFlagService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
  ) {
    this.state.contributeState(agentRuntimeBindingKey);
    this.state.contributeState(runtimeBindingKey);
    const initial = this.state.get(runtimeBindingKey) ?? seed.binding;
    this.assertSessionWorkspace(initial);
    this.state.set(agentRuntimeBindingKey, initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-runtime-binding', async (_ctx, next) => {
      const replayed = this.state.get(runtimeBindingKey);
      if (replayed === undefined) {
        void this.dispatcher.dispatch(
          new RuntimeSetBinding({ ...this.current, agentId: this.scopeContext.agentId }),
        );
        this.applySessionWorkDir(this.current);
        this.emitEnvironmentReminder(this.current);
      } else {
        this.assertSessionWorkspace(replayed);
        this.state.set(agentRuntimeBindingKey, replayed);
        this.applySessionWorkDir(replayed);
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
    return this.commit(binding);
  }

  private commit(binding: RuntimeBinding): RuntimeBinding {
    if (
      binding.workspaceId === this.current.workspaceId &&
      binding.runtimeId === this.current.runtimeId &&
      binding.cwd === this.current.cwd
    ) {
      return this.current;
    }
    const next = { workspaceId: binding.workspaceId, runtimeId: binding.runtimeId, cwd: binding.cwd };
    void this.dispatcher.dispatch(
      new RuntimeSetBinding({ ...next, agentId: this.scopeContext.agentId }),
    );
    this.state.set(agentRuntimeBindingKey, next);
    this.applySessionWorkDir(next);
    this.emitEnvironmentReminder(next);
    this.changeEmitter.fire(next);
    return next;
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
