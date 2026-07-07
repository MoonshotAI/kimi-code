/**
 * `externalHooks` domain (L6) — Agent-scope adapter for external
 * hook commands.
 *
 * Listens to hook slots and agent events owned by the agent behavior/lifecycle
 * domains (`toolExecutor`, `permissionGate`, `prompt`, `turn`, `loop`,
 * `fullCompaction`, `task`, and the `agentLifecycle` run hooks) and translates
 * those minimal contexts into the configured external hook commands, run
 * through the shared App-scope `IExternalHooksRunnerService` (so this adapter
 * never owns an engine lifecycle of its own) — including `SubagentStart` /
 * `SubagentStop`, which it now observes via the `IAgentRunHooksService` slots
 * rather than being invoked directly by the `agentLifecycle` wrapper. Appends
 * UserPromptSubmit hook results and Stop hook continuation prompts through
 * `contextMemory`.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentTaskService, type AgentTaskNotificationContext } from '#/agent/task';
import { IAgentContextMemoryService, USER_PROMPT_ORIGIN } from '#/agent/contextMemory';
import {
  IAgentFullCompactionService,
  type FullCompactionTask,
} from '#/agent/fullCompaction';
import type { CompactionResult, CompactionSource } from '#/agent/fullCompaction/types';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop';
import {
  IAgentPermissionGate,
} from '#/agent/permissionGate';
import {
  IAgentPromptService,
  type PromptSubmitContext,
} from '#/agent/prompt';
import type { HookResultEvent, TurnEndReason } from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event/eventBus';
import type {
  ExecutableToolResult,
  ToolDidExecuteContext,
  ToolWillExecuteContext,
} from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import {
  IAgentTurnService,
} from '#/agent/turn';
import { toKimiErrorPayload } from '#/errors';
import {
  IAgentRunHooksService,
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
} from '#/session/agentLifecycle/runHooks';

import { IAgentExternalHooksService } from './externalHooks';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './user-prompt';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'hook.result': HookResultEvent;
  }
}

const SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH = 500;

export class AgentExternalHooksService extends Disposable implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  private stopHookContinuationUsed = false;

  constructor(
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IInstantiationService private readonly instantiation: IInstantiationService,
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
    // Genuinely fire-and-forget: never throw on an already-aborted signal. A
    // cancelled tool still finalizes its result (e.g. the "manually interrupted"
    // output), and throwing here would clobber that with a finalize-abort error.
    // The runner mirrors the legacy fire-and-forget behavior.
    try {
      void this.runner.fireAndForgetTrigger(event, { matcherValue, signal, inputData });
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

    this.registerTurnHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTurnService)),
    );

    this.registerLoopHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService)),
    );

    this.registerFullCompactionHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentFullCompactionService)),
    );

    this.registerTaskHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskService)),
    );

    this.registerAgentTaskHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentRunHooksService)),
    );
  }

  private registerToolHooks(toolExecutor: IAgentToolExecutorService): void {
    this._register(
      toolExecutor.hooks.onWillExecuteTool.register('externalHooks', async (ctx, next) => {
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
      prompt.hooks.onWillSubmitPrompt.register('externalHooks', async (ctx, next) => {
        if (await this.runPromptSubmitHook(ctx)) {
          ctx.block = true;
          return;
        }
        await next();
      }),
    );
  }

  private registerTurnHooks(_turn: IAgentTurnService): void {
    this._register(
      this.eventBus.subscribe('turn.ended', (e) => this.notifyTurnEnded(e)),
    );
  }

  private registerLoopHooks(loop: IAgentLoopService): void {
    this._register(
      loop.hooks.afterStep.register('externalHooks', async (ctx, next) => {
        await next();
        if (
          ctx.finishReason === 'tool_calls' ||
          ctx.finishReason === 'filtered' ||
          ctx.continue
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
          ctx.continue = true;
          return;
        }
      }),
    );
  }

  private registerFullCompactionHooks(fullCompaction: IAgentFullCompactionService): void {
    this._register(
      fullCompaction.hooks.onWillCompact.register('externalHooks', async (ctx, next) => {
        await this.runPreCompact(ctx);
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('compaction.completed', (e) => this.notifyPostCompact(e)),
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

  private registerAgentTaskHooks(runHooks: IAgentRunHooksService): void {
    this._register(
      runHooks.hooks.onWillStartAgentTask.register('externalHooks', async (ctx, next) => {
        await this.runSubagentStart(ctx);
        await next();
      }),
    );
    this._register(
      runHooks.hooks.onDidStopAgentTask.register('externalHooks', (ctx, next) => {
        this.notifySubagentStop(ctx);
        return next();
      }),
    );
  }

  private async runPreToolUse(ctx: ToolWillExecuteContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    const toolInput = isPlainRecord(ctx.args) ? ctx.args : {};
    const block = await this.runner.triggerBlock('PreToolUse', {
      matcherValue: ctx.toolCall.name,
      signal: ctx.signal,
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

  private notifyTurnEnded(event: {
    turnId: number;
    reason: TurnEndReason;
    error?: unknown;
  }): void {
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
      inputData: {
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  private notifyPostCompact(event: { trigger: CompactionSource; result: CompactionResult }): void {
    this.fireAndForget(
      'PostCompact',
      {
        trigger: event.trigger,
        estimatedTokenCount: event.result.tokensAfter,
      },
      event.trigger,
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

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      inputData: {
        agentName: ctx.agentName,
        prompt: ctx.prompt.slice(0, SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
    ctx.signal.throwIfAborted();
  }

  private notifySubagentStop(ctx: AgentTaskStopHookContext): void {
    this.fireAndForget(
      'SubagentStop',
      {
        agentName: ctx.agentName,
        response: ctx.response.slice(0, SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH),
      },
      ctx.agentName,
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
