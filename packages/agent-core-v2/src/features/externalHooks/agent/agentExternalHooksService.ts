/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { historyEntryFromContext } from '#/agent/loop/history';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentFullCompactionService,
  type FullCompactionTask,
} from '#/agent/fullCompaction/fullCompaction';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import { IAgentLoopService, type AfterStepContext, type PromptSubmitContext } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { PromptQueued } from '#/agent/prompt/promptEvents';
import type { AgentTaskInfo } from '#/agent/task/task';
import { TaskStarted } from '#/agent/task/taskOps';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEvent2 } from '#/app/event/event2';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import {
  legacyDidExecuteContext,
  legacyResultToToolResult,
  type LegacyAfterContext,
} from '#/agent/toolExecutor/legacyHooks';
import {
  toLegacyToolReturn,
  type LegacyToolAgentContext,
  type ToolDecision,
  type ToolPrepareContext,
  type ToolResult,
} from '#/tool/executor';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { toKimiErrorPayload } from '#/errors';
import { fromCorePart } from '#human/message';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';

import { IAgentExternalHooksService } from './agentExternalHooks';
import { IExternalHooksRunnerService, type HookExecutionError } from '../app/externalHooksRunner';
import {
  blockDecision,
  updatedInputDecision,
  updatedToolOutputDecision,
} from '../internal/matchHooks';
import { sessionStartHookEntry } from '../internal/sessionStart';
import type { HookMatcherValue } from '../internal/types';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../internal/userPrompt';
import { ISessionExternalHooksService } from '../session/sessionExternalHooks';

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

export interface HookResultEvent extends Omit<HookResultPayload, 'agentId'> {
  readonly type: 'hook.result';
}

type StepFacts = Pick<AfterStepContext, 'turnId' | 'step' | 'firstStepOfTurn' | 'finishReason' | 'usage'>;

export class AgentExternalHooksService extends Service implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  private readonly stepFactsByTurn = new Map<number, StepFacts>();
  private readonly stopHookContinuationTurnIds = new Set<number>();
  private readonly stopHookAbortController = new AbortController();
  private stopHookQueue: Promise<void> = Promise.resolve();

  constructor(
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventBus private readonly eventBus: IEventBus,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentToolResultTruncationService private readonly truncation: IAgentToolResultTruncationService,
    @IWireService private readonly wire: IWireService,
    @ISessionExternalHooksService private readonly sessionHooks: ISessionExternalHooksService,
  ) {
    super();
    this._register({
      dispose: () => {
        this.stopHookAbortController.abort();
        this.stepFactsByTurn.clear();
        this.stopHookContinuationTurnIds.clear();
      },
    });
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
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      const sessionStartContext = this.sessionHooks.takeSessionStartContext();
      if (sessionStartContext !== undefined) {
        this.loop.remind(sessionStartHookEntry(sessionStartContext));
      }
      this._register(
        this.loop.hooks.onWillBeginStep.register('externalHooksSessionStart', async (_ctx, next) => {
          await this.sessionHooks.whenSessionStartSettled?.();
          await next();
        }),
      );
    }
  }

  private sessionTitle: string | undefined;

  private hookFailureWarned = false;

  private withSessionFacts(inputData: Record<string, unknown>): Record<string, unknown> {
    return { sessionTitle: this.sessionTitle, ...inputData };
  }

  private async hookCwd(): Promise<string> {
    await this.sessionMetadata.ready;
    return this.sessionMetadata.effectiveCwd;
  }

  private fireAndForget(
    event: string,
    inputData: Record<string, unknown>,
    matcherValue?: HookMatcherValue,
    signal?: AbortSignal,
  ): void {
    try {
      void this.hookCwd()
        .then((cwd) =>
          this.runner.fireAndForgetTrigger(event, {
            matcherValue,
            signal,
            cwd,
            sessionId: this.sessionContext.sessionId,
            inputData: this.withSessionFacts(inputData),
          }),
        )
        .catch(() => undefined);
    } catch {}
  }

  private warnHookFailure(failure: HookExecutionError): void {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    if (failure.sessionId !== undefined && failure.sessionId !== this.sessionContext.sessionId) {
      return;
    }
    if (this.hookFailureWarned) return;
    this.hookFailureWarned = true;
    void this.dispatcher.dispatch(
      new HookResult({
        agentId: this.scopeContext.agentId,
        hookEvent: failure.event,
        content: `A ${failure.event} hook failed to execute: ${failure.message}. Hooks always run on this local machine; check that the hook command works locally. Later hook failures in this session are logged without another warning.`,
      }),
    );
  }

  private registerListeners(): void {
    this._register(this.runner.onDidHookError((failure) => this.warnHookFailure(failure)));

    this.registerPermissionHooks();

    this.registerToolHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolExecutorService)),
    );

    this.registerPromptHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService)),
    );

    this.registerTurnHooks();

    this.registerLoopHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService)),
    );

    this.registerFullCompactionHooks(
      this.instantiation.invokeFunction((accessor) => accessor.get(IAgentFullCompactionService)),
    );

    this.registerTaskHooks();
  }

  private registerToolHooks(toolExecutor: IAgentToolExecutorService): void {
    this._register(
      toolExecutor.registerHook({
        validating: (context) => this.runPreToolUse(context),
        afterExecute: (context) => this.runPostToolUse(context),
      }),
    );
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

  private registerPromptHooks(loop: IAgentLoopService): void {
    this._register(
      loop.hooks.onBeforeSubmitPrompt.register('externalHooks', async (ctx, next) => {
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
          {
            promptId: e.promptId,
            prompt: e.content.map((part) => fromCorePart(part)),
            queueLength: e.queueLength,
          },
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
    if (event.origin.kind === 'system_trigger' && event.origin.name === 'stop_hook') {
      this.stopHookContinuationTurnIds.add(event.turnId);
    }
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

  private registerLoopHooks(loop: IAgentLoopService): void {
    this._register(
      loop.hooks.onDidFinishStep.register('externalHooks', async (ctx, next) => {
        await next();
        this.stepFactsByTurn.set(ctx.turnId, {
          turnId: ctx.turnId,
          step: ctx.step,
          firstStepOfTurn: ctx.firstStepOfTurn,
          finishReason: ctx.finishReason,
          usage: ctx.usage,
        });
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

  private registerTaskHooks(): void {
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

  private async runPreToolUse(
    context: ToolPrepareContext<unknown, LegacyToolAgentContext>,
  ): Promise<ToolDecision | void> {
    await this.runner.ready;
    if (!this.runner.hasHooksFor('PreToolUse')) return;
    context.signal.throwIfAborted();
    const toolInput = isPlainRecord(context.args) ? context.args : {};
    const results = await this.runner.trigger('PreToolUse', {
      matcherValue: context.call.name,
      signal: context.signal,
      cwd: await this.hookCwd(),
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        toolName: context.call.name,
        toolInput,
        toolCallId: context.call.id,
      }),
    });
    context.signal.throwIfAborted();
    const block = blockDecision('PreToolUse', results);
    if (block !== undefined) {
      return {
        reject: block.reason,
        result: toLegacyToolReturn(denyToolExecution(block.reason), context.call.name),
      };
    }
    const mutation = updatedInputDecision(results);
    if (mutation.invalid !== undefined) {
      return { reject: `PreToolUse hook returned a malformed updatedInput: ${mutation.invalid}` };
    }
    if (mutation.value !== undefined) return { args: mutation.value };
    return undefined;
  }

  private async runPostToolUse(context: LegacyAfterContext): Promise<ToolResult | void> {
    const ctx = legacyDidExecuteContext(context);
    const output = toolOutputText(ctx.result.output);
    const isError = ctx.result.isError === true;
    const event = isError ? 'PostToolUseFailure' : 'PostToolUse';
    await this.runner.ready;
    if (!this.runner.hasHooksFor(event)) return;
    const payload = {
      toolName: ctx.toolCall.name,
      toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
      toolCallId: ctx.toolCall.id,
      error: isError ? toKimiErrorPayload(output) : undefined,
      toolOutput: isError ? undefined : output.slice(0, 2000),
    };
    if (isError) {
      this.fireAndForget(event, payload, ctx.toolCall.name, ctx.signal);
      return;
    }
    const signal = context.context.steerSignal === undefined
      ? ctx.signal
      : AbortSignal.any([ctx.signal, context.context.steerSignal]);
    const results = await this.runner.trigger(event, {
      matcherValue: ctx.toolCall.name,
      signal,
      cwd: await this.hookCwd(),
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts(payload),
    });
    const mutation = updatedToolOutputDecision(results);
    if (mutation.invalid !== undefined) {
      this.warnHookFailure({
        event,
        sessionId: this.sessionContext.sessionId,
        message: `PostToolUse hook returned a malformed updatedToolOutput: ${mutation.invalid}`,
      });
      return;
    }
    if (mutation.value === undefined) return;
    const replacedOutput = updatedToolOutputValue(mutation.value);
    if (replacedOutput === undefined) {
      this.warnHookFailure({
        event,
        sessionId: this.sessionContext.sessionId,
        message:
          'PostToolUse hook returned updatedToolOutput content parts that are not valid content parts',
      });
      return;
    }
    const replaced = await this.truncation.truncateForModel({
      toolName: ctx.toolCall.name,
      toolCallId: ctx.toolCall.id,
      result: { ...ctx.result, output: replacedOutput },
    });
    if (context.prepared?.kind === 'execute' || context.prepared?.kind === 'synthetic') {
      context.prepared.result = replaced;
    }
    return legacyResultToToolResult(context, replaced);
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
      cwd: await this.hookCwd(),
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        prompt: input.map((part) => fromCorePart(part)),
        isSteer: ctx.isSteer,
      }),
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) {
      this.loop.remind(historyEntryFromContext({
        role: 'assistant',
        content: [{ type: 'text', text: block.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: block.event, blocked: true },
      }));
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
      ctx.hookParts.push(...append.parts);
      for (const message of append.messages) {
        void this.dispatcher.dispatch(
          new HookResult({
            agentId: this.scopeContext.agentId,
            hookEvent: append.event,
            content: message,
          }),
        );
      }
    }
    return false;
  }

  private notifyTurnEnded(event: TurnEnded): void {
    const stopHookContinuation = this.stopHookContinuationTurnIds.delete(event.turnId);
    const facts = this.stepFactsByTurn.get(event.turnId);
    this.stepFactsByTurn.delete(event.turnId);
    if (event.reason === 'failed' && event.error !== undefined) {
      this.notifyStopFailure(event.error, new AbortController().signal);
    }
    if (event.reason === 'cancelled') {
      this.fireAndForget('Interrupt', { turnId: event.turnId, reason: 'cancelled' });
    }
    if (event.reason !== 'completed' || facts === undefined) return;
    if (this.loop.snapshot().hasPendingRequests) return;
    const responseText = lastAssistantText(this.loop.history());
    this.stopHookQueue = this.stopHookQueue
      .then(() => this.runStop(facts, stopHookContinuation, responseText))
      .catch((error: unknown) => {
        if (this.stopHookAbortController.signal.aborted) return;
        this.warnHookFailure({
          event: 'Stop',
          sessionId: this.sessionContext.sessionId,
          message: toKimiErrorPayload(error).message,
        });
      });
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

  private async runStop(
    facts: StepFacts,
    stopHookContinuation: boolean,
    responseText: string | undefined,
  ): Promise<void> {
    const signal = this.stopHookAbortController.signal;
    signal.throwIfAborted();
    await this.runner.ready;
    if (!this.runner.hasHooksFor('Stop')) return;
    await this.wire.flush().catch(() => undefined);

    const block = await this.runner.triggerBlock('Stop', {
      signal,
      cwd: await this.hookCwd(),
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        turnId: facts.turnId,
        step: facts.step,
        firstStepOfTurn: facts.firstStepOfTurn,
        finishReason: facts.finishReason,
        usage: facts.usage,
        responseText: responseText ?? null,
        transcriptPath: this.wire.journalPath() ?? null,
        stopHookActive: stopHookContinuation,
      }),
    });
    signal.throwIfAborted();
    const reason = block?.reason;
    if (reason === undefined) return;
    if (stopHookContinuation) return;
    this.loop.notify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: reason }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      },
    });
  }

  private async runPreCompact(ctx: FullCompactionTask): Promise<void> {
    const signal = ctx.abortController.signal;
    signal.throwIfAborted();
    await this.runner.trigger('PreCompact', {
      matcherValue: ctx.trigger,
      signal,
      cwd: await this.hookCwd(),
      sessionId: this.sessionContext.sessionId,
      inputData: this.withSessionFacts({
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      }),
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

function updatedToolOutputValue(
  value: string | readonly unknown[],
): ExecutableToolResult['output'] | undefined {
  if (typeof value === 'string') return value;
  const parts: ContentPart[] = [];
  for (const item of value) {
    const part = asContentPart(item);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts;
}

function asContentPart(item: unknown): ContentPart | undefined {
  if (!isPlainRecord(item)) return undefined;
  switch (item['type']) {
    case 'text':
      return typeof item['text'] === 'string' ? (item as unknown as ContentPart) : undefined;
    case 'image_url':
      return hasPartUrl(item['imageUrl']) ? (item as unknown as ContentPart) : undefined;
    case 'audio_url':
      return hasPartUrl(item['audioUrl']) ? (item as unknown as ContentPart) : undefined;
    case 'video_url':
      return hasPartUrl(item['videoUrl']) ? (item as unknown as ContentPart) : undefined;
    default:
      return undefined;
  }
}

function hasPartUrl(value: unknown): boolean {
  return isPlainRecord(value) && typeof value['url'] === 'string';
}

function lastAssistantText(history: readonly ContextMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'assistant') continue;
    const text = message.content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}
