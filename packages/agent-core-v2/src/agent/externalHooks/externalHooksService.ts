/**
 * `externalHooks` domain (L6) — Agent-scope adapter for external
 * hook commands.
 *
 * Listens to hook slots and agent events owned by the agent behavior/lifecycle
 * domains (`toolExecutor`, `permissionGate`, `prompt`, `turn`, `loop`,
 * `fullCompaction`, and `task`) and translates those minimal contexts into the
 * configured external hook commands, run through the shared App-scope
 * `IExternalHooksRunnerService` (so this adapter never owns an engine lifecycle
 * of its own). The requester-side `SubagentStart` / `SubagentStop` hooks are
 * translated by the Session-scope `SessionExternalHooksService`, which observes
 * the `agentLifecycle` run slots hosted on `IAgentLifecycleService`. Appends
 * UserPromptSubmit hook results through `contextMemory`, drives Stop hook
 * continuations by enqueueing a mergeable `StepRequest` onto `loop`, and
 * passes the current session id from `sessionContext`
 * into hook runner payloads.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentTaskService, type AgentTaskNotificationContext } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import {
  IAgentFullCompactionService,
  type FullCompactionTask,
} from '#/agent/fullCompaction/fullCompaction';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import {
  IAgentPermissionGate,
} from '#/agent/permissionGate/permissionGate';
import {
  IAgentPromptService,
  type PromptSubmitContext,
} from '#/agent/prompt/prompt';
import type { HookResultEvent, TurnEndedEvent } from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event/eventBus';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext, ToolBeforeExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { toKimiErrorPayload } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentExternalHooksService } from './externalHooks';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './user-prompt';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'hook.result': HookResultEvent;
  }
}

export class AgentExternalHooksService extends Disposable implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  private stopHookContinuationUsed = false;

  constructor(
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
    this.registerListeners();
  }

  private fireAndForget(
    event: string,
    inputData: Record<string, unknown>,
    matcherValue?: string,
    signal?: AbortSignal,
  ): void {
    try {
      void this.runner.fireAndForgetTrigger(event, {
        matcherValue,
        signal,
        sessionId: this.sessionContext.sessionId,
        inputData,
      });
    } catch {}
  }

  private registerListeners(): void {
    this.registerToolHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolExecutorService)),
    );

    this.registerPermissionHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentPermissionGate)),
    );

    this.registerPromptHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentPromptService)),
    );

    this.registerTurnHooks();

    this.registerLoopHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService)),
    );

    this.registerFullCompactionHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentFullCompactionService)),
    );

    this.registerTaskHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskService)),
    );
  }

  private registerToolHooks(toolExecutor: IAgentToolExecutorService): void {
    this._register(
      toolExecutor.hooks.onBeforeExecuteTool.register('externalHooks', async (ctx, next) => {
        const reason = await this.runPreToolUse(ctx);
        if (reason !== undefined) {
          ctx.decision = { block: true, reason };
          return;
        }
        await next();
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('externalHooks', async (ctx, next) => {
        this.notifyPostToolUse(ctx);
        await next();
      }),
    );
  }

  private registerPermissionHooks(_permission: IAgentPermissionGate): void {
    this._register(
      this.eventBus.subscribe('permission.approval.requested', (e) => {
        const { type: _type, ...inputData } = e;
        this.fireAndForget('PermissionRequest', inputData, e.toolName);
      }),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.resolved', (e) => {
        const { type: _type, ...inputData } = e;
        this.fireAndForget('PermissionResult', inputData, e.toolName);
      }),
    );
  }

  private registerPromptHooks(prompt: IAgentPromptService): void {
    this._register(
      prompt.hooks.onBeforeSubmitPrompt.register('externalHooks', async (ctx, next) => {
        if (await this.runPromptSubmitHook(ctx)) {
          ctx.block = true;
          return;
        }
        await next();
      }),
    );
  }

  private registerTurnHooks(): void {
    this._register(
      this.eventBus.subscribe('turn.ended', (e) => this.notifyTurnEnded(e)),
    );
  }

  private registerLoopHooks(loop: IAgentLoopService): void {
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
          this.context.append({
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

  private registerFullCompactionHooks(fullCompaction: IAgentFullCompactionService): void {
    this._register(
      fullCompaction.hooks.onWillCompact.register('externalHooks', async (ctx, next) => {
        await this.runPreCompact(ctx);
        void ctx.promise
          .then((result) => this.notifyPostCompact(ctx, result))
          .catch(() => undefined);
        await next();
      }),
    );
  }

  private registerTaskHooks(_tasks: IAgentTaskService): void {
    this._register(
      this.eventBus.subscribe('task.notified', (e) => {
        const { type: _type, ...ctx } = e;
        this.notifyTaskNotification(ctx);
      }),
    );
  }

  private async runPreToolUse(ctx: ToolBeforeExecuteContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    const toolInput = isPlainRecord(ctx.args) ? ctx.args : {};
    const block = await this.runner.triggerBlock('PreToolUse', {
      matcherValue: ctx.toolCall.name,
      signal: ctx.signal,
      sessionId: this.sessionContext.sessionId,
      inputData: {
        toolName: ctx.toolCall.name,
        toolInput,
        toolCallId: ctx.toolCall.id,
      },
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
      inputData: { prompt: input, isSteer: ctx.isSteer },
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) {
      this.context.append({
        role: 'assistant',
        content: [{ type: 'text', text: block.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: block.event, blocked: true },
      });
      this.eventBus.publish({
        type: 'hook.result',
        hookEvent: block.event,
        content: block.message,
        blocked: true,
      });
      return true;
    }

    const append = renderUserPromptHookResult(results);
    if (append !== undefined) {
      this.context.append({
        role: 'user',
        content: [{ type: 'text', text: append.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: append.event },
      });
      this.eventBus.publish({
        type: 'hook.result',
        hookEvent: append.event,
        content: append.message,
      });
    }
    return false;
  }

  private notifyTurnEnded(event: Pick<TurnEndedEvent, 'turnId' | 'reason' | 'error'>): void {
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
      inputData: { stopHookActive: false },
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private async runPreCompact(ctx: FullCompactionTask): Promise<void> {
    const signal = ctx.abortController.signal;
    signal.throwIfAborted();
    await this.runner.trigger('PreCompact', {
      matcherValue: ctx.trigger,
      signal,
      sessionId: this.sessionContext.sessionId,
      inputData: {
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  private notifyPostCompact(ctx: FullCompactionTask, result: CompactionResult): void {
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentExternalHooksService,
  AgentExternalHooksService,
  InstantiationType.Eager,
  'externalHooks',
);
