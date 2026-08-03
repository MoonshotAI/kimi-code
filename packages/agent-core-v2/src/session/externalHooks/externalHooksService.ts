/**
 * `externalHooks` domain — Session-scope adapter for external hook
 * commands.
 *
 * Registers with the per-session `sessionLifecycleHooks` slots (seeded by
 * the Workspace-scope `sessionLifecycle`, which runs them around
 * create/close) to run `SessionStart` and `SessionEnd` external commands
 * for the current `sessionContext`, and
 * observes the requester-side agent-run hook slot (`onWillStartAgentTask`) and
 * stop event (`onDidStopAgentTask`) hosted on the `subagent` domain's
 * `ISessionSubagentService` to translate them into the `SubagentStart` /
 * `SubagentStop` external commands. It also owns the periodic
 * `SessionHeartbeat` command (one timer per session, ticking only when the
 * event is configured), enriches every payload it sends with the cached
 * session title (seeded from and kept fresh by `ISessionMetadata`), and
 * resolves the SessionStart model/profile facts from `IModelService` /
 * `ISessionAgentProfileCatalog`. The slot/event host lives on the service
 * that owns the run; this adapter only registers its
 * own listeners here, so the runner owns the slots it runs — the same pattern
 * the Agent-scope adapter follows against the agent behavior services. The
 * actual hook execution is delegated to the shared App-scope
 * `IExternalHooksRunnerService`; all config/plugin loading and engine lifecycle
 * live in the runner. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer } from '#/_base/utils/timer';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import type { Hooks } from '#/hooks';
import { IModelService } from '#/kosong/model/model';
import {
  ISessionAgentProfileCatalog,
} from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionLifecycleHooks,
  type SessionCloseReason,
  type SessionCreateSource,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
} from '#/session/subagent/subagent';

import { ISessionExternalHooksService } from './externalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

const HEARTBEAT_INTERVAL_MS = 60_000;

export class SessionExternalHooksService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  private sessionTitle: string | undefined;
  private readonly createdAt = Date.now();

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionLifecycleHooks lifecycleHooks: Hooks<SessionLifecycleHookSlots>,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @IModelService private readonly models: IModelService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
  ) {
    super();
    void this.metadata
      .read()
      .then((meta) => {
        this.sessionTitle = meta.title;
      })
      .catch(() => undefined);
    this._register(
      this.metadata.onDidChangeMetadata((event) => {
        if (!event.changed.includes('title')) return;
        void this.metadata
          .read()
          .then((meta) => {
            this.sessionTitle = meta.title;
          })
          .catch(() => undefined);
      }),
    );
    this._register(
      lifecycleHooks.onDidCreateSession.register('externalHooks', async (event, next) => {
        if (event.source !== 'fork') {
          await this.triggerSessionStart(event.source);
        }
        await next();
      }),
    );
    this._register(
      lifecycleHooks.onWillCloseSession.register('externalHooks', async (event, next) => {
        await this.triggerSessionEnd(event.reason);
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

    // Arm the heartbeat only once the configured-hook index has loaded and
    // only when the event has hooks at all, so sessions without a
    // SessionHeartbeat hook never hold a recurring timer. Re-sync on every
    // hook-index reload (plugin reload) so late-registered heartbeat hooks
    // still arm, and removed ones disarm.
    void this.runner.ready
      .then(() => this.syncHeartbeat())
      .catch(() => undefined);
    this._register(this.runner.onDidReload(() => this.syncHeartbeat()));
  }

  private readonly heartbeat = this._register(new IntervalTimer({ unref: true }));

  private syncHeartbeat(): void {
    try {
      if (this.runner.hasHooksFor('SessionHeartbeat')) {
        this.heartbeat.cancelAndSet(() => this.tickHeartbeat(), HEARTBEAT_INTERVAL_MS);
      } else {
        this.heartbeat.cancel();
      }
    } catch {}
  }

  private async triggerSessionStart(source: SessionStartHookSource): Promise<void> {
    await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: {
        source,
        sessionTitle: this.sessionTitle,
        model: this.models.getDefaultModel(),
        profile: await this.defaultProfileName(),
      },
    });
  }

  private async defaultProfileName(): Promise<string | undefined> {
    try {
      await this.profiles.ready;
      return this.profiles.getDefault().name;
    } catch {
      return undefined;
    }
  }

  private async triggerSessionEnd(reason: SessionCloseReason): Promise<void> {
    await this.runner.trigger('SessionEnd', {
      matcherValue: reason,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: { reason, sessionTitle: this.sessionTitle },
    });
  }

  private tickHeartbeat(): void {
    try {
      if (!this.runner.hasHooksFor('SessionHeartbeat')) return;
      void this.runner.fireAndForgetTrigger('SessionHeartbeat', {
        cwd: this.context.cwd,
        sessionId: this.context.sessionId,
        inputData: {
          sessionTitle: this.sessionTitle,
          uptimeMs: Date.now() - this.createdAt,
        },
      });
    } catch {}
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: {
        agentName: ctx.agentName,
        prompt: ctx.prompt,
        sessionTitle: this.sessionTitle,
      },
    });
    ctx.signal.throwIfAborted();
  }

  private notifySubagentStop(ctx: AgentTaskStopHookContext): void {
    void this.runner.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: {
        agentName: ctx.agentName,
        response: ctx.response,
        sessionTitle: this.sessionTitle,
      },
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalHooksService,
  SessionExternalHooksService,
  ScopeActivation.OnScopeCreated,
  'externalHooks',
);
