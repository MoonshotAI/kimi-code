import { toKimiErrorPayload } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { IPluginService } from '#/app/plugin';
import { Disposable } from '#/_base/di';
import { HookEngine } from './engine';
import {
  IAgentExternalHooksService,
  type ExternalHooksServiceOptions,
  type NotificationHookPayload,
  type PermissionRequestHookPayload,
  type PermissionResultHookPayload,
  type UserPromptHookDecision,
} from './externalHooks';
import {
  HOOKS_SECTION,
  type HookDefConfig,
} from './configSection';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './user-prompt';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';

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

  constructor(
    private readonly options: ExternalHooksServiceOptions = {},
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
  ) {
    super();
    if (options.hookEngine === undefined) {
      this.dynamicEngine = new HookEngine([], { cwd: this.bootstrap.cwd });
      void this.loadDynamicHooks();
      // Rebuild the dynamic engine when plugins are reloaded so hook
      // additions/removals take effect without restarting the session.
      this._register(
        this.plugins.onDidReload(() => {
          void this.loadDynamicHooks();
        }),
      );
    }
    toolExecutor.hooks.onWillExecuteTool.register('externalHooks', async (ctx, next) => {
      const reason = await this.triggerPreToolUse(
        {
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
        },
        ctx.signal,
      );
      if (reason !== undefined) {
        ctx.decision = { block: true, reason };
        return;
      }
      await next();
    });
    toolExecutor.hooks.onDidExecuteTool.register('externalHooks', async (ctx, next) => {
      await this.triggerPostToolUse(
        {
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
          result: ctx.result,
        },
        ctx.signal,
      );
      await next();
    });
  }

  private engine(): ExternalHooksServiceOptions['hookEngine'] {
    return this.options.hookEngine ?? this.dynamicEngine;
  }

  private async loadDynamicHooks(): Promise<void> {
    await this.config.ready;
    const configured = this.config.get(HOOKS_SECTION) as readonly HookDefConfig[] | undefined;
    const pluginHooks = await this.plugins.enabledHooks();
    this.dynamicEngine = new HookEngine([...(configured ?? []), ...pluginHooks], {
      cwd: this.bootstrap.cwd,
    });
  }

  async triggerPreToolUse(
    payload: Parameters<IAgentExternalHooksService['triggerPreToolUse']>[0],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const block = await this.engine()?.triggerBlock('PreToolUse', {
      matcherValue: payload.toolName,
      signal,
      inputData: {
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolCallId: payload.toolCallId,
      },
    });
    signal.throwIfAborted();
    return block?.reason;
  }

  async triggerUserPromptSubmit(
    input: Parameters<IAgentExternalHooksService['triggerUserPromptSubmit']>[0],
    signal: AbortSignal,
  ): Promise<UserPromptHookDecision | undefined> {
    signal.throwIfAborted();
    const results = await this.engine()?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) return { action: 'block', ...block };

    const append = renderUserPromptHookResult(results);
    return append === undefined ? undefined : { action: 'append', ...append };
  }

  async triggerStop(signal: AbortSignal, stopHookActive: boolean): Promise<string | undefined> {
    signal.throwIfAborted();
    const block = await this.engine()?.triggerBlock('Stop', {
      signal,
      inputData: { stopHookActive },
    });
    signal.throwIfAborted();
    return block?.reason;
  }

  async triggerPostToolUse(
    payload: Parameters<IAgentExternalHooksService['triggerPostToolUse']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    const output = toolOutputText(payload.result.output);
    const isError = payload.result.isError === true;
    fireAndForget(
      this.engine(),
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolCallId: payload.toolCallId,
        error: isError ? toKimiErrorPayload(output) : undefined,
        toolOutput: isError ? undefined : output.slice(0, 2000),
      },
      signal,
      payload.toolName,
    );
  }

  triggerPermissionRequest(payload: PermissionRequestHookPayload): void {
    void this.engine()?.fireAndForgetTrigger('PermissionRequest', {
      matcherValue: payload.toolName,
      inputData: {
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        action: payload.action,
        toolInput: payload.toolInput,
        display: payload.display,
      },
    });
  }

  triggerPermissionResult(payload: PermissionResultHookPayload): void {
    void this.engine()?.fireAndForgetTrigger('PermissionResult', {
      matcherValue: payload.toolName,
      inputData: permissionResultInputData(payload),
    });
  }

  triggerStopFailure(error: unknown, signal: AbortSignal): void {
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

  triggerInterrupt(payload: Parameters<IAgentExternalHooksService['triggerInterrupt']>[0]): void {
    void this.engine()?.fireAndForgetTrigger('Interrupt', {
      inputData: payload,
    });
  }

  async triggerPreCompact(
    payload: Parameters<IAgentExternalHooksService['triggerPreCompact']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.engine()?.trigger('PreCompact', {
      matcherValue: payload.trigger,
      signal,
      inputData: {
        trigger: payload.trigger,
        tokenCount: payload.tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  triggerPostCompact(payload: Parameters<IAgentExternalHooksService['triggerPostCompact']>[0]): void {
    void this.engine()?.fireAndForgetTrigger('PostCompact', {
      matcherValue: payload.trigger,
      inputData: {
        trigger: payload.trigger,
        estimatedTokenCount: payload.estimatedTokenCount,
      },
    });
  }

  triggerNotification(payload: NotificationHookPayload): void {
    const signal = new AbortController().signal;
    fireAndForget(
      this.engine(),
      'Notification',
      { sink: 'context', ...payload },
      signal,
      payload.notificationType,
    );
  }

  async triggerSubagentStart(
    payload: Parameters<IAgentExternalHooksService['triggerSubagentStart']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.engine()?.trigger('SubagentStart', {
      matcherValue: payload.agentName,
      signal,
      inputData: {
        agentName: payload.agentName,
        prompt: payload.prompt,
      },
    });
    signal.throwIfAborted();
  }

  triggerSubagentStop(
    payload: Parameters<IAgentExternalHooksService['triggerSubagentStop']>[0],
  ): void {
    void this.engine()?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: payload.agentName,
      inputData: {
        agentName: payload.agentName,
        response: payload.response,
      },
    });
  }
}

function toolOutputText(
  output: Parameters<IAgentExternalHooksService['triggerPostToolUse']>[0]['result']['output'],
): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function permissionResultInputData(payload: PermissionResultHookPayload): Record<string, unknown> {
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
  InstantiationType.Delayed,
  'externalHooks',
);
