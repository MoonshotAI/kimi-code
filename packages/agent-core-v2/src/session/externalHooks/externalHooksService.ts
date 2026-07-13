/**
 * `externalHooks` domain (L6) — Session-scope adapter for external hook
 * commands.
 *
 * Registers with `sessionLifecycle` hook slots to run `SessionStart` and
 * `SessionEnd` external commands for the current `sessionContext`, and
 * observes the requester-side agent-run hook slot (`onWillStartAgentTask`) and
 * stop event (`onDidStopAgentTask`) hosted on `agentLifecycle`'s
 * `IAgentLifecycleService` to translate them into the `SubagentStart` /
 * `SubagentStop` external commands. The slot/event host lives on the service
 * that owns the run (run by `mirrorAgentRun`); this adapter only registers its
 * own listeners here, so the runner owns the slots it runs — the same pattern
 * the Agent-scope adapter follows against the agent behavior services. The
 * actual hook execution is delegated to the shared App-scope
 * `IExternalHooksRunnerService`; all config/plugin loading and engine lifecycle
 * live in the runner. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import {
  ISessionLifecycleService,
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/app/sessionLifecycle/sessionLifecycle';
import {
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

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
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
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
      agentLifecycle.hooks.onWillStartAgentTask.register('externalHooks', async (ctx, next) => {
        await this.runSubagentStart(ctx);
        await next();
      }),
    );
    this._register(agentLifecycle.onDidStopAgentTask((ctx) => this.notifySubagentStop(ctx)));
  }

  private async triggerSessionStart(source: SessionStartHookSource): Promise<void> {
    await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: SessionCloseReason): Promise<void> {
    await this.runner.trigger('SessionEnd', {
      matcherValue: reason,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: { reason },
    });
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
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
      inputData: {
        agentName: ctx.agentName,
        response: ctx.response,
      },
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalHooksService,
  SessionExternalHooksService,
  InstantiationType.Eager,
  'externalHooks',
);
