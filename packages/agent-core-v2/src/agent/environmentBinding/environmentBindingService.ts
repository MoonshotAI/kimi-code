import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { loadAgentsMdDetailed } from '#/agent/profile/context';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext, ContextInjectionResult, ReminderRegistration } from '#/features/reminder/types';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding, type EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';
import { resolveEffectiveWorkspaceRoots } from '#/session/workspaceContext/workspaceRoots';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';

import {
  IAgentEnvironmentBindingSeed,
  IAgentEnvironmentBindingService,
  type LocalWorkDirRebindInput,
} from './environmentBinding';
import { EnvironmentSetBinding, environmentBindingKey } from './environmentBindingOps';

export const ENVIRONMENT_BINDING_REMINDER_VARIANT = 'environment_binding';

export const PROJECT_CONTEXT_REMINDER_VARIANT = 'project_context';

export const MISSING_WORKDIR_REMINDER_VARIANT = 'missing_workdir';

interface MissingWorkdirDisclosure {
  readonly missingCwd?: string;
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

export class AgentEnvironmentBindingService implements IAgentEnvironmentBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<EnvironmentBinding>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly restoreHook: IDisposable;
  private readonly missingWorkdirRegistration: ReminderRegistration | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentEnvironmentBindingSeed private readonly seed: IAgentEnvironmentBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @ISessionProjectInfo private readonly projectInfo: ISessionProjectInfo,
    @IEnvironmentService private readonly resolver: EnvironmentResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @ILogService private readonly log: ILogService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    this.state.contributeState(environmentBindingKey);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-environment-binding', async (_ctx, next) => {
      const replayed = this.state.get(environmentBindingKey);
      if (replayed === undefined) {
        await this.dispatcher.dispatch(
          new EnvironmentSetBinding({ ...this.current, agentId: this.scopeContext.agentId }),
        );
      }
      this.applySessionWorkDir(this.current);
      if (replayed === undefined ? this.current.environmentId !== LOCAL_ENVIRONMENT_ID : this.isSeedRoundTrip(replayed)) {
        this.emitEnvironmentReminder(this.current);
      }
      await next();
    });
    this.missingWorkdirRegistration =
      this.scopeContext.agentId === MAIN_AGENT_ID
        ? this.reminder.register<MissingWorkdirDisclosure>(MISSING_WORKDIR_REMINDER_VARIANT, (context) =>
            this.missingWorkdirReminder(context),
          )
        : undefined;
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
    this.workspaceContext.setWorkDir(this.effectiveRoots(binding).workDir);
  }

  private effectiveRoots(binding: EnvironmentBinding, host?: HostEnvironmentInfo) {
    let resolvedHost = host;
    if (resolvedHost === undefined && binding.cwd === undefined && binding.environmentId !== LOCAL_ENVIRONMENT_ID) {
      try {
        resolvedHost = this.resolver.inspect(binding).host;
      } catch {
        resolvedHost = undefined;
      }
    }
    return resolveEffectiveWorkspaceRoots(this.session, binding, this.projectInfo, resolvedHost);
  }

  get current(): EnvironmentBinding {
    return this.state.get(environmentBindingKey) ?? this.seed.binding;
  }

  bind(environmentId: string, cwd?: string): EnvironmentBinding {
    const binding: EnvironmentBinding = { environmentId, cwd };
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    return this.commit(binding);
  }

  async rebindLocalWorkDir(input: LocalWorkDirRebindInput): Promise<EnvironmentBinding> {
    const next: EnvironmentBinding = {
      environmentId: LOCAL_ENVIRONMENT_ID,
      cwd: input.cwd,
    };
    await this.dispatcher.dispatch(
      new EnvironmentSetBinding({
        agentId: this.scopeContext.agentId,
        environmentId: LOCAL_ENVIRONMENT_ID,
        cwd: input.cwd,
        originCwd: input.originCwd,
        pendingBaseline: input.pendingBaseline,
      }),
    );
    this.state.set(environmentBindingKey, next);
    this.applySessionWorkDir(next);
    this.changeEmitter.fire(next);
    return next;
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
    this.state.set(environmentBindingKey, next);
    this.applySessionWorkDir(next);
    this.emitProjectContextReminder(next);
    this.changeEmitter.fire(next);
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
    this.reminder.notify(
      environmentReminderText(binding, environment, this.effectiveRoots(binding, environment).workDir),
      { variant: ENVIRONMENT_BINDING_REMINDER_VARIANT },
    );
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
      const host = lease.environment.host;
      const homeDir = host?.homeDir;
      if (homeDir === undefined) return;
      const cwd = this.effectiveRoots(binding, host).workDir;
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

  private async missingWorkdirReminder(
    context: ContextInjectionContext<MissingWorkdirDisclosure>,
  ): Promise<ContextInjectionResult<MissingWorkdirDisclosure> | undefined> {
    if (!context.isNewTurn) return undefined;
    const binding = this.current;
    if (binding.environmentId !== LOCAL_ENVIRONMENT_ID) return undefined;
    const cwd = this.effectiveRoots(binding).workDir;
    let lease: EnvironmentLease;
    try {
      lease = this.resolver.acquire(binding, ['fs']);
    } catch (error) {
      if (error instanceof EnvironmentError) return undefined;
      throw error;
    }
    try {
      const fs = lease.environment.fs;
      if (fs === undefined) return undefined;
      const state: 'present' | 'missing' | 'unknown' = await fs.stat(cwd).then(
        (stat) => (stat.isDirectory ? 'present' : 'missing'),
        (error: unknown) =>
          isHostFsNotFound(error) || isHostFsNotDirectory(error) ? 'missing' : 'unknown',
      );
      if (state === 'unknown') return undefined;
      if (state === 'present') {
        if (context.lastDisclosure?.missingCwd !== cwd) return undefined;
        return {
          content: `The working directory \`${cwd}\` is available again.`,
          disclosure: {},
        };
      }
      if (context.lastDisclosure?.missingCwd === cwd) return undefined;
      return {
        content: `The working directory \`${cwd}\` no longer exists.`,
        disclosure: { missingCwd: cwd },
      };
    } finally {
      lease.dispose();
    }
  }

  dispose(): void {
    this.missingWorkdirRegistration?.dispose();
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentEnvironmentBindingService, AgentEnvironmentBindingService, ScopeActivation.OnScopeCreated, 'agentEnvironmentBinding');
