import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { loadAgentsMdDetailed } from '#/agent/profile/context';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding, type EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';

import { IAgentEnvironmentBindingSeed, IAgentEnvironmentBindingService } from './environmentBinding';
import { EnvironmentSetBinding, environmentBindingKey } from './environmentBindingOps';

export const agentEnvironmentBindingKey = defineState<EnvironmentBinding>('environment.binding', () => ({ environmentId: LOCAL_ENVIRONMENT_ID }));

export const ENVIRONMENT_BINDING_REMINDER_VARIANT = 'environment_binding';

export const PROJECT_CONTEXT_REMINDER_VARIANT = 'project_context';

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

export class AgentEnvironmentBindingService implements IAgentEnvironmentBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<EnvironmentBinding>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly restoreHook: IDisposable;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentEnvironmentBindingSeed private readonly seed: IAgentEnvironmentBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IEnvironmentService private readonly resolver: EnvironmentResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @ILogService private readonly log: ILogService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    this.state.contributeState(agentEnvironmentBindingKey);
    this.state.contributeState(environmentBindingKey);
    const initial = this.state.get(environmentBindingKey) ?? seed.binding;
    this.state.set(agentEnvironmentBindingKey, initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-environment-binding', async (_ctx, next) => {
      const replayed = this.state.get(environmentBindingKey);
      if (replayed !== undefined) {
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
      await this.persistIfChanged(this.current);
      await next();
    });
  }

  private async persistIfChanged(binding: EnvironmentBinding): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    const persisted = await this.metadata.read();
    const persistedId = persisted.environmentId ?? LOCAL_ENVIRONMENT_ID;
    if (persistedId === binding.environmentId && persisted.environmentCwd === binding.cwd) return;
    await this.metadata.update(
      { environmentId: binding.environmentId, environmentCwd: binding.cwd },
      { touchUpdatedAt: false },
    );
  }

  private isSeedRoundTrip(binding: EnvironmentBinding): boolean {
    const seed = this.seed.binding;
    return (
      binding.environmentId !== LOCAL_ENVIRONMENT_ID &&
      binding.environmentId === seed.environmentId &&
      binding.cwd === seed.cwd
    );
  }

  private applySessionWorkDir(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    this.workspaceContext.setWorkDir(binding.cwd ?? this.session.cwd);
  }

  get current(): EnvironmentBinding {
    return this.state.get(agentEnvironmentBindingKey);
  }

  bind(environmentId: string, cwd?: string): EnvironmentBinding {
    const binding: EnvironmentBinding = { environmentId, cwd };
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    return this.commit(binding);
  }

  private commit(binding: EnvironmentBinding): EnvironmentBinding {
    const previous = this.current;
    if (
      binding.environmentId === previous.environmentId &&
      binding.cwd === previous.cwd
    ) {
      return previous;
    }
    const next = { environmentId: binding.environmentId, cwd: binding.cwd };
    void this.dispatcher.dispatch(
      new EnvironmentSetBinding({ ...next, agentId: this.scopeContext.agentId }),
    );
    this.state.set(agentEnvironmentBindingKey, next);
    this.applySessionWorkDir(next);
    this.emitProjectContextReminder(next);
    this.changeEmitter.fire(next);
    void this.persistIfChanged(next);
    return next;
  }

  private emitEnvironmentReminder(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    let environment: HostEnvironmentInfo;
    try {
      const host = this.resolver.inspect(binding).host;
      if (host === undefined) return;
      environment = host;
    } catch {
      return;
    }
    this.reminder.notify(environmentReminderText(binding, environment, this.session.cwd), {
      variant: ENVIRONMENT_BINDING_REMINDER_VARIANT,
    });
  }

  private emitProjectContextReminder(binding: EnvironmentBinding): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
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
      const homeDir = lease.environment.host?.homeDir;
      if (homeDir === undefined) return;
      const cwd = binding.cwd ?? this.session.cwd;
      const { paths } = await loadAgentsMdDetailed(
        { fs, homeDir },
        cwd,
        this.bootstrap.homeDir,
      );
      if (paths.length === 0) return;
      this.reminder.notify(projectContextReminderText(binding, cwd, paths), {
        variant: PROJECT_CONTEXT_REMINDER_VARIANT,
      });
    } finally {
      lease.dispose();
    }
  }

  dispose(): void {
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentEnvironmentBindingService, AgentEnvironmentBindingService, ScopeActivation.OnScopeCreated, 'agentEnvironmentBinding');
