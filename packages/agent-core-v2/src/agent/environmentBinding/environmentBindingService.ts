import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService } from '#/agent/loop/loop';
import { loadAgentsMdDetailed } from '#/agent/profile/context';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentConversationUndoParticipantRegistry, type AgentConversationUndoParticipant } from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { CHANGE_ENVIRONMENT_TOOL_NAME } from '#/features/environmentTools/environmentTools';
import { planKey } from '#/features/plan/planOps';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding, type EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IEnvironmentResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentEnvironmentBindingSeed, IAgentEnvironmentBindingService } from './environmentBinding';
import { EnvironmentSetBinding, environmentBindingKey } from './environmentBindingOps';

export const agentEnvironmentBindingKey = defineState<EnvironmentBinding>('environment.binding', () => ({ workspaceId: '', environmentId: LOCAL_ENVIRONMENT_ID }));

export const ENVIRONMENT_BINDING_REMINDER_VARIANT = 'environment_binding';

export const PROJECT_CONTEXT_REMINDER_VARIANT = 'project_context';

function projectContextViewKey(binding: EnvironmentBinding, fallbackCwd: string): string {
  return `${binding.environmentId}\n${binding.cwd ?? fallbackCwd}`;
}

function projectContextReminderText(binding: EnvironmentBinding, cwd: string, paths: readonly string[]): string {
  return (
    `The active project context is now "${binding.environmentId}" at working directory ${cwd}. ` +
    'Previous working directories, AGENTS.md instructions, and environment details no longer apply. ' +
    'The AGENTS.md file(s) below apply to this working directory:\n' +
    paths.map((path) => `- ${path}`).join('\n') +
    '\nRead them before making changes in this working directory.'
  );
}

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
  private readonly undoParticipant: IDisposable;
  private readonly visitedViews = new Set<string>();

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentEnvironmentBindingSeed private readonly seed: IAgentEnvironmentBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IEnvironmentResolver private readonly resolver: IEnvironmentResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ref(IAgentLoopService) private readonly loop: LiveRef<IAgentLoopService>,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IEnvironmentDeclarationService private readonly environmentDeclarations: IEnvironmentDeclarationService,
    @ILogService private readonly log: ILogService,
    @IAgentConversationUndoParticipantRegistry undoParticipants: IAgentConversationUndoParticipantRegistry,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    this.state.contributeState(agentEnvironmentBindingKey);
    this.state.contributeState(environmentBindingKey);
    const initial = this.state.get(environmentBindingKey) ?? seed.binding;
    this.assertSessionWorkspace(initial);
    this.state.set(agentEnvironmentBindingKey, initial);
    this.markProjectContextVisited(initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-environment-binding', async (_ctx, next) => {
      const replayed = this.state.get(environmentBindingKey);
      if (replayed !== undefined) {
        this.assertSessionWorkspace(replayed);
        this.state.set(agentEnvironmentBindingKey, replayed);
        this.applySessionWorkDir(replayed);
        if (this.isSeedRoundTrip(replayed)) {
          this.emitEnvironmentReminder(replayed);
        }
      } else {
        await this.dispatcher.dispatch(
          new EnvironmentSetBinding({ ...this.current, agentId: this.scopeContext.agentId }),
        );
        this.applySessionWorkDir(this.current);
        if (this.current.environmentId !== LOCAL_ENVIRONMENT_ID) {
          this.emitEnvironmentReminder(this.current);
        }
      }
      this.markProjectContextVisited(this.current);
      await next();
    });
    const participant: AgentConversationUndoParticipant = {
      id: 'agent-environment-binding',
      reconcileAfterUndo: () => this.reconcileAfterUndo(),
    };
    this.undoParticipant = undoParticipants.register(participant);
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

  private assertNotInPlanMode(): void {
    if (!this.state.has(planKey) || !this.state.get(planKey).active) return;
    throw new EnvironmentError(
      'environment.conflict',
      'cannot switch environment while plan mode is active; exit plan mode first',
    );
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

  private foreignInFlightToolCallCount(): number {
    const activeToolCalls = this.loop.current?.snapshot().turn?.activeToolCalls ?? [];
    const self = activeToolCalls.some((call) => call.name === CHANGE_ENVIRONMENT_TOOL_NAME) ? 1 : 0;
    return activeToolCalls.length - self;
  }

  private applySessionWorkDir(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    this.workspaceContext.setWorkDir(binding.cwd ?? this.session.cwd);
  }

  get current(): EnvironmentBinding {
    return this.state.get(agentEnvironmentBindingKey);
  }

  get(): EnvironmentBinding {
    return this.current;
  }

  set(binding: EnvironmentBinding): EnvironmentBinding {
    this.assertSessionWorkspace(binding);
    this.assertNotInPlanMode();
    this.assertSwitchAllowed();
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    return this.commit(binding);
  }

  async connectAndSwitch(environmentId: string, cwd?: string): Promise<EnvironmentBinding> {
    const binding: EnvironmentBinding = { workspaceId: this.session.workspaceId, environmentId, cwd };
    this.assertSessionWorkspace(binding);
    this.assertNotInPlanMode();
    this.assertSwitchAllowed();
    await this.prepareSwitch(binding);
    return this.commit(binding);
  }

  async connectAndSwitchInTurn(environmentId: string, cwd?: string): Promise<EnvironmentBinding> {
    const binding: EnvironmentBinding = { workspaceId: this.session.workspaceId, environmentId, cwd };
    this.assertSessionWorkspace(binding);
    this.assertNotInPlanMode();
    const foreign = this.foreignInFlightToolCallCount();
    if (foreign > 0) {
      throw new EnvironmentError(
        'environment.conflict',
        `cannot switch environment while ${foreign} other tool call(s) are in flight; retry when no other calls are running`,
      );
    }
    await this.prepareSwitch(binding);
    return this.commit(binding);
  }

  private async prepareSwitch(binding: EnvironmentBinding): Promise<void> {
    if (binding.environmentId !== LOCAL_ENVIRONMENT_ID && binding.cwd === undefined) {
      throw new EnvironmentError('environment.invalid_cwd', `binding environment ${binding.environmentId} requires a cwd`);
    }
    await this.environmentDeclarations.ensureConnected(binding.workspaceId, binding.environmentId);
    if (binding.environmentId === LOCAL_ENVIRONMENT_ID || binding.cwd === undefined) return;
    await this.environmentDeclarations.assertCwdUsable(binding.workspaceId, binding.environmentId, binding.cwd);
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
    this.emitProjectContextReminder(next);
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

  private async reconcileAfterUndo(): Promise<void> {
    const target = this.state.get(environmentBindingKey) ?? this.seed.binding;
    const previous = this.current;
    if (
      target.workspaceId === previous.workspaceId &&
      target.environmentId === previous.environmentId &&
      target.cwd === previous.cwd
    ) {
      return;
    }
    this.state.set(agentEnvironmentBindingKey, target);
    this.applySessionWorkDir(target);
    if (this.machineIdentityChanged(previous, target)) {
      this.emitEnvironmentReminder(target);
    }
    this.changeEmitter.fire(target);
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

  private markProjectContextVisited(binding: EnvironmentBinding): void {
    this.visitedViews.add(projectContextViewKey(binding, this.session.cwd));
  }

  private emitProjectContextReminder(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    if (this.visitedViews.has(projectContextViewKey(binding, this.session.cwd))) return;
    this.markProjectContextVisited(binding);
    void this.probeProjectContext(binding).catch((error: unknown) => {
      this.log.warn(`project context probe for environment ${binding.environmentId} failed`, { error });
    });
  }

  private async probeProjectContext(binding: EnvironmentBinding): Promise<void> {
    let lease: EnvironmentLease;
    try {
      lease = this.resolver.acquire(binding, ['fs']);
    } catch (error) {
      if (error instanceof EnvironmentError) return;
      throw error;
    }
    try {
      const fs = lease.environment.fs;
      if (fs === undefined) return;
      const cwd = binding.cwd ?? this.session.cwd;
      const { paths } = await loadAgentsMdDetailed(
        { fs, homeDir: lease.environment.host.homeDir },
        cwd,
        this.bootstrap.homeDir,
      );
      if (paths.length === 0) return;
      if (projectContextViewKey(this.current, this.session.cwd) !== projectContextViewKey(binding, this.session.cwd)) {
        return;
      }
      this.reminder.notify(projectContextReminderText(binding, cwd, paths), {
        variant: PROJECT_CONTEXT_REMINDER_VARIANT,
      });
    } finally {
      lease.dispose();
    }
  }

  switch(environmentId: string, cwd?: string): EnvironmentBinding {
    return this.set({ workspaceId: this.session.workspaceId, environmentId, cwd });
  }

  dispose(): void {
    this.undoParticipant.dispose();
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentEnvironmentBindingService, AgentEnvironmentBindingService, ScopeActivation.OnScopeCreated, 'agentEnvironmentBinding');
