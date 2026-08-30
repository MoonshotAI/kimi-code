/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { type AgentTaskInfo, type AgentTaskNotificationContext } from '#/actor/task/types';
import { AgentContextMemory, ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { USER_PROMPT_ORIGIN } from '#/actor/contextMemory/types';
import {
  AgentFullCompaction,
  type FullCompactionHookContext,
  type FullCompactionRuntime,
} from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import type { CompactionResult } from '#/actor/fullCompaction/types';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { AfterStepContext, LoopControl } from '#/actor/loop/internal/loop';
import { ContinuationStepRequest } from '#/actor/loop/internal/stepRequest';
import { TurnStarted } from '#/actor/loop/turnEvents';
import { TurnEnded } from '#/actor/loop/turnOps';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import type { PromptSubmitContext } from '#/actor/prompt/prompt';
import { PromptQueued } from '#/actor/prompt/promptEvents';
import { TaskNotified, TaskStarted } from '#/actor/task/taskOps';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEvent2 } from '#/app/event/event2';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext, ToolDidExecuteContext } from '#/actor/toolExecutor/toolHooks';
import { denyToolExecution } from '#/actor/toolExecutor/toolHooks';
import { activateToolExecutorWhenReady } from '#/actor/toolExecutor/internal/executorActivation';
import type { AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { toKimiErrorPayload } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentExternalHooksService } from './agentExternalHooks';
import { IExternalHooksRunnerService } from '../app/externalHooksRunner';
import type { HookMatcherValue } from '../internal/types';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../internal/userPrompt';

export interface HookResultPayload {
  readonly agentId: string;
  readonly turnId?: number;
  readonly hookEvent: string;
  readonly content: string;
  readonly blocked?: boolean;
}

export class HookResult extends AgentEvent2<HookResultPayload> {
  static override readonly type = 'hook.result';
  static override readonly observable = true;
}
export interface HookResult extends HookResultPayload {}

export const externalHooksStopHookContinuationUsedKey = defineState<boolean>(
  'externalHooks.stopHookContinuationUsed',
  () => false,
);

export class AgentExternalHooksService extends Service implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  private readonly context: ContextMemoryRuntime;

  constructor(
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
    @IEventBus private readonly eventBus: IEventBus,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentStateService private readonly states: IAgentStateService,
    private readonly scopeContext: IAgentScopeContext,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this.context = manager.resolve(scopeContext.agentContext, AgentContextMemory);
    this.states.contributeState(externalHooksStopHookContinuationUsedKey);
    void this.sessionMetadata
      .read()
      .then((meta) => {
        this.sessionTitle = meta.title;
      })
      .catch(() => undefined);
    this._register(
      this.sessionMetadata.onDidChangeMetadata((event) => {
        if (!event.changed.includes('title')) return;
        void this.sessionMetadata
          .read()
          .then((meta) => {
            this.sessionTitle = meta.title;
          })
          .catch(() => undefined);
      }),
    );
    this.registerListeners();
  }

  private sessionTitle: string | undefined;

  private withSessionFacts(inputData: Record<string, unknown>): Record<string, unknown> {
    return { sessionTitle: this.sessionTitle, ...inputData };
  }

  private get stopHookContinuationUsed(): boolean {
    return this.states.get(externalHooksStopHookContinuationUsedKey);
  }

  private set stopHookContinuationUsed(value: boolean) {
    this.states.set(externalHooksStopHookContinuationUsedKey, value);
  }

  private fireAndForget(
    event: string,
    inputData: Record<string, unknown>,
    matcherValue?: HookMatcherValue,
    signal?: AbortSignal,
  ): void {
    try {
      void this.runner.fireAndForgetTrigger(event, {
        matcherValue,
        signal,
        sessionId: this.sessionContext.sessionId,
        inputData: this.withSessionFacts(inputData),
      });
    } catch {}
  }

  private registerListeners(): void {
    this.registerPermissionHooks();

    this._register(
      activateToolExecutorWhenReady(this.manager, this.scopeContext, (executor) =>
        this.registerToolHooks(executor),
      ),
    );


    this.registerPromptHooks();

    this.registerTurnHooks();

    this.registerLoopHooks(getLoopControl(this.scopeContext));

    this.registerFullCompactionHooks(
      this.manager.resolve(this.scopeContext.agentContext, AgentFullCompaction),
    );

    this.registerTaskHooks();
  }

  private registerToolHooks(executor: AgentToolsRuntime): IDisposable {
    const registrations: IDisposable[] = [
      executor.participateExecution('externalHooks', async (event) => {
        const reason = await this.runPreToolUse(event);
        if (reason !== undefined) {
          event.veto(denyToolExecution(reason));
        }
      }),
      executor.registerDidExecuteHook('externalHooks', async (ctx, next) => {
        this.notifyPostToolUse(ctx);
        await next();
      }),
    ];
    return toDisposable(() => {
      for (const registration of registrations.splice(0)) registration.dispose();
    });
  }

  private registerPermissionHooks(): void {
    this._register(
      this.eventBus.subscribe(PermissionApprovalRequested, (e) => {
        const { type: _type, time: _time, ...inputData } = e;
        this.fireAndForget('PermissionRequest', inputData, e.toolName);
      }),
    );
    this._register(
      this.eventBus.subscribe(PermissionApprovalResolved, (e) => {
        const { type: _type, time: _time, ...inputData } = e;
        this.fireAndForget('PermissionResult', inputData, e.toolName);
      }),
    );
  }

  private registerPromptHooks(): void {
    this._register(
      this.manager.resolve(this.scopeContext.agentContext, AgentPrompt).registerBeforeSubmitHook('externalHooks', async (ctx, next) => {
        if (await this.runPromptSubmitHook(ctx)) {
          ctx.block = true;
          return;
        }
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(PromptQueued, (e) => {
        this.fireAndForget(
          'UserPromptQueued',
          { promptId: e.promptId, prompt: e.content, queueLength: e.queueLength },
          e.content,
        );
      }),
    );
  }

  private registerTurnHooks(): void {
    this._register(
      this.eventBus.subscribe(TurnStarted, (e) => this.notifyTurnStarted(e)),
    );
    this._register(
      this.eventBus.subscribe(TurnEnded, (e) => this.notifyTurnEnded(e)),
    );
  }

  private notifyTurnStarted(event: TurnStarted): void {
    this.fireAndForget(
      'TurnStarted',
      {
        turnId: event.turnId,
        originKind: event.origin.kind,
        originName: 'name' in event.origin ? event.origin.name : undefined,
        prompt: event.prompt,
      },
      event.origin.kind,
    );
  }

  private registerLoopHooks(loop: LoopControl): void {
    this._register(
      loop.hooks.onDidFinishStep.register('externalHooks', async (ctx, next) => {
        await next();
        if (
          ctx.finishReason === 'tool_calls' ||
          ctx.finishReason === 'filtered' ||
          loop.hasPendingRequests()
        ) {
          return;
        }
        const reason = await this.runStop(ctx);
        if (reason !== undefined) {
          this.stopHookContinuationUsed = true;
          void this.context.append({
            role: 'user',
            content: [{ type: 'text', text: reason }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'stop_hook' },
          });
          loop.enqueue(
            new ContinuationStepRequest({
              kind: 'stop_hook',
              mergeable: true,
              admission: 'activeOrNextTurn',
            }),
          );
          return;
        }
      }),
    );
  }

  private registerFullCompactionHooks(fullCompaction: FullCompactionRuntime): void {
    this._register(
      fullCompaction.registerBeforeCompactHook('externalHooks', async (ctx) => {
        await this.runPreCompact(ctx);
        void ctx.settlement
          .then((result) => this.notifyPostCompact(ctx, result))
          .catch(() => undefined);
      }),
    );
  }

  private registerTaskHooks(): void {
    this._register(
      this.eventBus.subscribe(TaskNotified, (e) => {
        const { type: _type, time: _time, ...ctx } = e;
        this.notifyTaskNotification(ctx);
      }),
    );
    this._register(
      this.eventBus.subscribe(TaskStarted, (e) => this.notifyTaskStarted(e.info)),
    );
  }

  private notifyTaskStarted(info: AgentTaskInfo): void {
    this.fireAndForget(
      'TaskStarted',
      {
        taskId: info.taskId,
        kind: info.kind,
        description: info.description,
        status: info.status,
        detached: info.detached,
        startedAt: info.startedAt,
      },
      info.kind,
    );
  }

  private async runPreToolUse(ctx: ResolvedToolExecutionHookContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    const toolInput = isPlainRecord(ctx.args) ? ctx.args : {};
    const block = await this.runner.triggerBlock('PreToolUse', {
      matcherValue: ctx.toolCall.name,
      signal: ctx.signal,
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        toolName: ctx.toolCall.name,
        toolInput,
        toolCallId: ctx.toolCall.id,
      }),
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private notifyPostToolUse(ctx: ToolDidExecuteContext): void {
    const output = toolOutputText(ctx.result.output);
    const isError = ctx.result.isError === true;
    this.fireAndForget(
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        toolName: ctx.toolCall.name,
        toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
        toolCallId: ctx.toolCall.id,
        error: isError ? toKimiErrorPayload(output) : undefined,
        toolOutput: isError ? undefined : output.slice(0, 2000),
      },
      ctx.toolCall.name,
      ctx.signal,
    );
  }

  private async runPromptSubmitHook(
    ctx: PromptSubmitContext,
  ): Promise<boolean> {
    if ((ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return false;

    const signal = new AbortController().signal;
    const input = ctx.promptMessage.content;
    signal.throwIfAborted();
    const results = await this.runner.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({ prompt: input, isSteer: ctx.isSteer }),
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) {
      void this.context.append({
        role: 'assistant',
        content: [{ type: 'text', text: block.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: block.event, blocked: true },
      });
      void this.dispatcher.dispatch(
        new HookResult({
          agentId: this.scopeContext.agentId,
          hookEvent: block.event,
          content: block.message,
          blocked: true,
        }),
      );
      return true;
    }

    const append = renderUserPromptHookResult(results);
    if (append !== undefined) {
      void this.context.append({
        role: 'user',
        content: [{ type: 'text', text: append.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: append.event },
      });
      void this.dispatcher.dispatch(
        new HookResult({
          agentId: this.scopeContext.agentId,
          hookEvent: append.event,
          content: append.message,
        }),
      );
    }
    return false;
  }

  private notifyTurnEnded(event: TurnEnded): void {
    this.stopHookContinuationUsed = false;
    if (event.reason === 'failed' && event.error !== undefined) {
      this.notifyStopFailure(event.error, new AbortController().signal);
    }
    if (event.reason === 'cancelled') {
      this.fireAndForget('Interrupt', { turnId: event.turnId, reason: 'cancelled' });
    }
  }

  private notifyStopFailure(error: unknown, signal: AbortSignal): void {
    const payload = toKimiErrorPayload(error);
    this.fireAndForget(
      'StopFailure',
      {
        errorType: payload.name,
        errorMessage: payload.message,
      },
      payload.name,
      signal,
    );
  }

  private async runStop(ctx: AfterStepContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    if (this.stopHookContinuationUsed) return undefined;

    const block = await this.runner.triggerBlock('Stop', {
      signal: ctx.signal,
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({ stopHookActive: false }),
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private async runPreCompact(ctx: FullCompactionHookContext): Promise<void> {
    const signal = ctx.signal;
    signal.throwIfAborted();
    await this.runner.trigger('PreCompact', {
      matcherValue: ctx.trigger,
      signal,
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      }),
    });
    signal.throwIfAborted();
  }

  private notifyPostCompact(ctx: FullCompactionHookContext, result: CompactionResult): void {
    this.fireAndForget(
      'PostCompact',
      {
        trigger: ctx.trigger,
        estimatedTokenCount: result.tokensAfter,
      },
      ctx.trigger,
    );
  }

  private notifyTaskNotification(ctx: AgentTaskNotificationContext): void {
    const signal = new AbortController().signal;
    this.fireAndForget(
      'Notification',
      { sink: 'context', ...ctx },
      ctx.notificationType,
      signal,
    );
  }
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}
