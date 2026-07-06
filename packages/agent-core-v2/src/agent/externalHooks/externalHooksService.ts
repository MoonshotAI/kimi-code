/**
 * `externalHooks` domain (L5) — Agent-scope adapter for external
 * hook commands.
 *
 * Listens to hook slots owned by the agent behavior/lifecycle domains
 * (`toolExecutor`, `permissionGate`, `prompt`, `turn`, `loop`, `fullCompaction`, and
 * `task`) and translates those minimal contexts into the configured external
 * HookEngine events. Appends UserPromptSubmit hook results and Stop hook
 * continuation prompts through `contextMemory`. The `SubagentStart` /
 * `SubagentStop` pair is the one
 * exception: the `agentLifecycle` tool wrapper has no hook service of its own,
 * so `mirrorAgentRun` invokes `runAgentTaskStart` / `notifyAgentTaskStop` on
 * this service directly.
 */

import { Disposable, IInstantiationService } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isUserCancellation } from '#/_base/utils/abort';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentTaskService, type AgentTaskNotificationContext } from '#/agent/task';
import { IAgentContextMemoryService, USER_PROMPT_ORIGIN } from '#/agent/contextMemory';
import {
  IAgentFullCompactionService,
  type FullCompactionDidCompactContext,
  type FullCompactionWillCompactContext,
} from '#/agent/fullCompaction';
import { IAgentLoopService, type TurnAfterStepContext } from '#/agent/loop';
import {
  IAgentPermissionGate,
  type PermissionApprovalResultContext,
} from '#/agent/permissionGate';
import {
  IAgentPromptService,
  type PromptSubmitContext,
} from '#/agent/prompt';
import type { HookResultEvent } from '@moonshot-ai/protocol';
import { IAgentWireService, type IWireService } from '#/wire';
import type {
  ExecutableToolResult,
  ToolDidExecuteContext,
  ToolWillExecuteContext,
} from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import {
  IAgentTurnService,
  type TurnEndedContext,
} from '#/agent/turn';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { IPluginService } from '#/app/plugin';
import { toKimiErrorPayload } from '#/errors';

import { HOOKS_SECTION, type HookDefConfig } from './configSection';
import { HookEngine } from './engine';
import {
  IAgentExternalHooksService,
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  type ExternalHooksServiceOptions,
} from './externalHooks';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './user-prompt';

declare module '#/wire' {
  interface SignalMap {
    'hook.result': Omit<HookResultEvent, 'type'>;
  }
}

const SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH = 500;

function fireAndForget(
  engine: ExternalHooksServiceOptions['hookEngine'],
  event: string,
  inputData: Record<string, unknown>,
  signal: AbortSignal,
  matcherValue?: string,
): void {
  // Genuinely fire-and-forget: never throw on an already-aborted signal. A
  // cancelled tool still finalizes its result (e.g. the "manually interrupted"
  // output), and throwing here would clobber that with a finalize-abort error.
  // Matches legacy `fireAndForgetTrigger`, which fires unconditionally.
  void engine?.fireAndForgetTrigger(event, { matcherValue, signal, inputData });
}

export class AgentExternalHooksService extends Disposable implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  private dynamicEngine: HookEngine | undefined;
  private stopHookContinuationUsed = false;

  constructor(
    private readonly options: ExternalHooksServiceOptions = {},
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentWireService private readonly wire: IWireService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
  ) {
    super();
    if (options.hookEngine === undefined) {
      this.dynamicEngine = new HookEngine([], { cwd: this.bootstrap.cwd });
      void this.loadDynamicHooks();
      this._register(
        this.plugins.onDidReload(() => {
          void this.loadDynamicHooks();
        }),
      );
    }
    this.registerListeners();
  }

  private engine(): ExternalHooksServiceOptions['hookEngine'] {
    return this.options.hookEngine ?? this.dynamicEngine;
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

  private registerPermissionHooks(permission: IAgentPermissionGate): void {
    this._register(
      permission.hooks.onDidRequestApproval.register('externalHooks', async (ctx, next) => {
        void this.engine()?.fireAndForgetTrigger('PermissionRequest', {
          matcherValue: ctx.toolName,
          inputData: {
            turnId: ctx.turnId,
            toolCallId: ctx.toolCallId,
            toolName: ctx.toolName,
            action: ctx.action,
            toolInput: ctx.toolInput,
            display: ctx.display,
          },
        });
        await next();
      }),
    );
    this._register(
      permission.hooks.onDidResolveApproval.register('externalHooks', async (ctx, next) => {
        void this.engine()?.fireAndForgetTrigger('PermissionResult', {
          matcherValue: ctx.toolName,
          inputData: permissionResultInputData(ctx),
        });
        await next();
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

  private registerTurnHooks(turn: IAgentTurnService): void {
    this._register(
      turn.hooks.onEnded.register('externalHooks', async (ctx, next) => {
        this.notifyTurnEnded(ctx);
        await next();
      }),
    );
  }

  private registerLoopHooks(loop: IAgentLoopService): void {
    this._register(
      loop.hooks.afterStep.register('externalHooks', async (ctx, next) => {
        await next();
        if (
          ctx.stopReason === 'tool_calls' ||
          ctx.stopReason === 'filtered' ||
          ctx.continue
        ) {
          return;
        }
        const reason = await this.runStop(ctx);
        if (reason !== undefined) {
          this.stopHookContinuationUsed = true;
          this.context.splice(this.context.get().length, 0, [{
            role: 'user',
            content: [{ type: 'text', text: reason }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'stop_hook' },
          }]);
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
      fullCompaction.hooks.onDidCompact.register('externalHooks', async (ctx, next) => {
        this.notifyPostCompact(ctx);
        await next();
      }),
    );
  }

  private registerTaskHooks(tasks: IAgentTaskService): void {
    this._register(
      tasks.hooks.onDidNotify.register('externalHooks', async (ctx, next) => {
        this.notifyTaskNotification(ctx);
        await next();
      }),
    );
  }

  private async loadDynamicHooks(): Promise<void> {
    await this.config.ready;
    const configured = this.config.get(HOOKS_SECTION) as readonly HookDefConfig[] | undefined;
    const pluginHooks = await this.plugins.enabledHooks();
    this.dynamicEngine = new HookEngine([...(configured ?? []), ...pluginHooks], {
      cwd: this.bootstrap.cwd,
    });
  }

  private async runPreToolUse(ctx: ToolWillExecuteContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    const toolInput = isPlainRecord(ctx.args) ? ctx.args : {};
    const block = await this.engine()?.triggerBlock('PreToolUse', {
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
    fireAndForget(
      this.engine(),
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        toolName: ctx.toolCall.name,
        toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
        toolCallId: ctx.toolCall.id,
        error: isError ? toKimiErrorPayload(output) : undefined,
        toolOutput: isError ? undefined : output.slice(0, 2000),
      },
      ctx.signal,
      ctx.toolCall.name,
    );
  }

  private async runPromptSubmitHook(
    ctx: PromptSubmitContext,
  ): Promise<boolean> {
    if ((ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return false;

    const signal = new AbortController().signal;
    const input = ctx.promptMessage.content;
    signal.throwIfAborted();
    const results = await this.engine()?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input, isSteer: ctx.isSteer },
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) {
      this.context.splice(this.context.get().length, 0, [{
        role: 'assistant',
        content: [{ type: 'text', text: block.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: block.event, blocked: true },
      }]);
      this.wire.signal({
        type: 'hook.result',
        hookEvent: block.event,
        content: block.message,
        blocked: true,
      });
      return true;
    }

    const append = renderUserPromptHookResult(results);
    if (append !== undefined) {
      this.context.splice(this.context.get().length, 0, [{
        role: 'user',
        content: [{ type: 'text', text: append.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: append.event },
      }]);
      this.wire.signal({
        type: 'hook.result',
        hookEvent: append.event,
        content: append.message,
      });
    }
    return false;
  }

  private notifyTurnEnded(ctx: TurnEndedContext): void {
    this.stopHookContinuationUsed = false;
    if (ctx.result.reason === 'failed' && ctx.result.error !== undefined) {
      this.notifyStopFailure(ctx.result.error, ctx.turn.abortController.signal);
    }
    if (
      ctx.result.reason === 'cancelled' &&
      isUserCancellation(ctx.turn.abortController.signal.reason)
    ) {
      void this.engine()?.fireAndForgetTrigger('Interrupt', {
        inputData: { turnId: ctx.turn.id, reason: 'cancelled' },
      });
    }
  }

  private notifyStopFailure(error: unknown, signal: AbortSignal): void {
    const payload = toKimiErrorPayload(error);
    fireAndForget(
      this.engine(),
      'StopFailure',
      {
        errorType: payload.name,
        errorMessage: payload.message,
      },
      signal,
      payload.name,
    );
  }

  private async runStop(ctx: TurnAfterStepContext): Promise<string | undefined> {
    ctx.signal.throwIfAborted();
    if (this.stopHookContinuationUsed) return undefined;

    const block = await this.engine()?.triggerBlock('Stop', {
      signal: ctx.signal,
      inputData: { stopHookActive: false },
    });
    ctx.signal.throwIfAborted();
    return block?.reason;
  }

  private async runPreCompact(ctx: FullCompactionWillCompactContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.engine()?.trigger('PreCompact', {
      matcherValue: ctx.trigger,
      signal: ctx.signal,
      inputData: {
        trigger: ctx.trigger,
        tokenCount: ctx.tokenCount,
      },
    });
    ctx.signal.throwIfAborted();
  }

  private notifyPostCompact(ctx: FullCompactionDidCompactContext): void {
    void this.engine()?.fireAndForgetTrigger('PostCompact', {
      matcherValue: ctx.trigger,
      inputData: {
        trigger: ctx.trigger,
        estimatedTokenCount: ctx.estimatedTokenCount,
      },
    });
  }

  private notifyTaskNotification(ctx: AgentTaskNotificationContext): void {
    const signal = new AbortController().signal;
    fireAndForget(
      this.engine(),
      'Notification',
      { sink: 'context', ...ctx },
      signal,
      ctx.notificationType,
    );
  }

  async runAgentTaskStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.engine()?.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      inputData: {
        agentName: ctx.agentName,
        prompt: ctx.prompt.slice(0, SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
    ctx.signal.throwIfAborted();
  }

  notifyAgentTaskStop(ctx: AgentTaskStopHookContext): void {
    void this.engine()?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      inputData: {
        agentName: ctx.agentName,
        response: ctx.response.slice(0, SUBAGENT_HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
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

function permissionResultInputData(
  payload: PermissionApprovalResultContext,
): Record<string, unknown> {
  if (payload.decision === 'error') {
    return {
      turnId: payload.turnId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      action: payload.action,
      decision: payload.decision,
      error: payload.error,
    };
  }
  return {
    turnId: payload.turnId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    action: payload.action,
    decision: payload.decision,
    scope: payload.scope,
    feedback: payload.feedback,
    selectedLabel: payload.selectedLabel,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentExternalHooksService,
  AgentExternalHooksService,
  InstantiationType.Eager,
  'externalHooks',
);
