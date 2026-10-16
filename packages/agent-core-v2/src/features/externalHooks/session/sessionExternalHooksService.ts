import { Service } from '#/_base/di/service';
import { IntervalTimer } from '#/_base/utils/timer';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IModelService } from '#/llm-adapter/model/model';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionAgentProfileCatalog,
} from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

import { HookResult as HookResultEvent } from '../agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from '../app/externalHooksRunner';
import type { HookResult as HookRunResult } from '../internal/types';
import { hookResultMessage, renderHookResult } from '../internal/userPrompt';
import { ISessionExternalHooksService } from './sessionExternalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

const HEARTBEAT_INTERVAL_MS = 60_000;

export class SessionExternalHooksService
  extends Service
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  private sessionTitle: string | undefined;
  private readonly createdAt = Date.now();

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionManager lifecycle: ISessionManager,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @IModelService private readonly models: IModelService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
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
    const onDidCreate = lifecycle.onDidCreateSession;
    if (onDidCreate !== undefined) {
      this._register(
        onDidCreate((event) => {
          if (event.sessionId !== this.context.sessionId) return;
          if (event.source !== 'fork') {
            event.waitUntil(this.triggerSessionStart(event.source));
          }
        }),
      );
    }
    const onWillClose = lifecycle.onWillCloseSession;
    if (onWillClose !== undefined) {
      this._register(
        onWillClose((event) => {
          if (event.sessionId !== this.context.sessionId) return;
          event.waitUntil(this.triggerSessionEnd(event.reason));
        }),
      );
    }
    this._register(
      subagents.hooks.onWillStartAgentTask.register('externalHooks', async (ctx, next) => {
        await this.runSubagentStart(ctx);
        await next();
      }),
    );
    this._register(subagents.onDidStopAgentTask((ctx) => this.notifySubagentStop(ctx)));

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
    const results = await this.runner.trigger('SessionStart', {
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
    this.surfaceSessionStartResults(results);
  }

  private surfaceSessionStartResults(results: readonly HookRunResult[]): void {
    const messages = results
      .filter((result) => result.action !== 'block')
      .map(hookResultMessage)
      .filter((message): message is string => message !== undefined);
    if (messages.length === 0) return;
    const main = this.agents.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return;
    const memory = main.accessor.get(IAgentContextMemoryService);
    const dispatcher = main.accessor.get(IEventDispatcher);
    for (const message of messages) {
      memory.append({
        role: 'assistant',
        content: [{ type: 'text', text: renderHookResult('SessionStart', message) }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'SessionStart' },
      });
      void dispatcher.dispatch(
        new HookResultEvent({
          agentId: MAIN_AGENT_ID,
          hookEvent: 'SessionStart',
          content: message,
        }),
      );
    }
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
