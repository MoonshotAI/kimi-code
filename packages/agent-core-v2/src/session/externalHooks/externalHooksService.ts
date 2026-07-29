/**
 * `externalHooks` domain (L6) — Session-scope adapter for external hook
 * commands.
 *
 * Registers with `sessionLifecycle` hook slots to run `SessionStart` and
 * `SessionEnd` external commands for the current `sessionContext`, and
 * observes the requester-side agent-run hook slot (`onWillStartAgentTask`) and
 * stop event (`onDidStopAgentTask`) hosted on the `subagent` domain's
 * `ISessionSubagentService` to translate them into the `SubagentStart` /
 * `SubagentStop` external commands. The slot/event host lives on the service
 * that owns the run (run by `mirrorAgentRun`); this adapter only registers its
 * own listeners here, so the runner owns the slots it runs — the same pattern
 * the Agent-scope adapter follows against the agent behavior services. The
 * actual hook execution is delegated to the shared App-scope
 * `IExternalHooksRunnerService`; all config/plugin loading and engine lifecycle
 * live in the runner. For every translated event, this adapter resolves the
 * current effective mode from the relevant Agent scope through
 * `agentLifecycle` and `permissionMode`: main for session lifecycle events,
 * requester for subagent events. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import {
  ISessionLifecycleService,
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
} from '#/session/subagent/subagent';

import { ISessionExternalHooksService } from './externalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

export class SessionExternalHooksService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionLifecycleService lifecycle: ISessionLifecycleService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
  ) {
    super();
    this._register(
      lifecycle.hooks.onDidCreateSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId && event.source !== 'fork') {
          await this.triggerSessionStart(event.source);
        }
        await next();
      }),
    );
    this._register(
      lifecycle.hooks.onWillCloseSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId) {
          await this.triggerSessionEnd(event.reason);
        }
        await next();
      }),
    );
    this._register(
      subagents.hooks.onWillStartAgentTask.register('externalHooks', async (ctx, next) => {
        await this.runSubagentStart(ctx);
        await next();
      }),
    );
    this._register(subagents.onDidStopAgentTask((ctx) => this.notifySubagentStop(ctx)));
  }

  private async triggerSessionStart(source: SessionStartHookSource): Promise<void> {
    await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      permissionMode: this.permissionMode(MAIN_AGENT_ID),
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: SessionCloseReason): Promise<void> {
    await this.runner.trigger('SessionEnd', {
      matcherValue: reason,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      permissionMode: this.permissionMode(MAIN_AGENT_ID),
      inputData: { reason },
    });
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      permissionMode: this.permissionMode(ctx.requesterAgentId),
      inputData: {
        agentName: ctx.agentName,
        prompt: ctx.prompt,
      },
    });
    ctx.signal.throwIfAborted();
  }

  private notifySubagentStop(ctx: AgentTaskStopHookContext): void {
    void this.runner.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      permissionMode: this.permissionMode(ctx.requesterAgentId),
      inputData: {
        agentName: ctx.agentName,
        response: ctx.response,
      },
    });
  }

  private permissionMode(agentId: string | undefined): PermissionMode | undefined {
    if (agentId === undefined) return undefined;
    return this.agents.get(agentId)?.accessor.get(IAgentPermissionModeService).mode;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalHooksService,
  SessionExternalHooksService,
  ScopeActivation.OnScopeCreated,
  'externalHooks',
);
