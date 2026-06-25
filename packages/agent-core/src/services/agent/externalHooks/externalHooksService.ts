import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../../../session/hooks';
import { toKimiErrorPayload } from '../../../errors';
import {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
  type NotificationHookPayload,
  type PermissionRequestHookPayload,
  type PermissionResultHookPayload,
  type UserPromptHookDecision,
} from './externalHooks';

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

export class ExternalHooksService implements IExternalHooksService {
  constructor(private readonly options: ExternalHooksServiceOptions = {}) {}

  async triggerPreToolUse(
    payload: Parameters<IExternalHooksService['triggerPreToolUse']>[0],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const block = await this.options.hookEngine?.triggerBlock('PreToolUse', {
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
    input: Parameters<IExternalHooksService['triggerUserPromptSubmit']>[0],
    signal: AbortSignal,
  ): Promise<UserPromptHookDecision | undefined> {
    signal.throwIfAborted();
    const results = await this.options.hookEngine?.trigger('UserPromptSubmit', {
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
    const block = await this.options.hookEngine?.triggerBlock('Stop', {
      signal,
      inputData: { stopHookActive },
    });
    signal.throwIfAborted();
    return block?.reason;
  }

  async triggerPostToolUse(
    payload: Parameters<IExternalHooksService['triggerPostToolUse']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    const output = toolOutputText(payload.result.output);
    const isError = payload.result.isError === true;
    fireAndForget(
      this.options.hookEngine,
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
    void this.options.hookEngine?.fireAndForgetTrigger('PermissionRequest', {
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
    void this.options.hookEngine?.fireAndForgetTrigger('PermissionResult', {
      matcherValue: payload.toolName,
      inputData: permissionResultInputData(payload),
    });
  }

  triggerStopFailure(error: unknown, signal: AbortSignal): void {
    const payload = toKimiErrorPayload(error);
    fireAndForget(
      this.options.hookEngine,
      'StopFailure',
      {
        errorType: payload.name,
        errorMessage: payload.message,
      },
      signal,
      payload.name,
    );
  }

  triggerInterrupt(payload: Parameters<IExternalHooksService['triggerInterrupt']>[0]): void {
    void this.options.hookEngine?.fireAndForgetTrigger('Interrupt', {
      inputData: payload,
    });
  }

  async triggerPreCompact(
    payload: Parameters<IExternalHooksService['triggerPreCompact']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.options.hookEngine?.trigger('PreCompact', {
      matcherValue: payload.trigger,
      signal,
      inputData: {
        trigger: payload.trigger,
        tokenCount: payload.tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  triggerPostCompact(payload: Parameters<IExternalHooksService['triggerPostCompact']>[0]): void {
    void this.options.hookEngine?.fireAndForgetTrigger('PostCompact', {
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
      this.options.hookEngine,
      'Notification',
      { sink: 'context', ...payload },
      signal,
      payload.notificationType,
    );
  }
}

function toolOutputText(
  output: Parameters<IExternalHooksService['triggerPostToolUse']>[0]['result']['output'],
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

registerSingleton(
  IExternalHooksService,
  new SyncDescriptor(ExternalHooksService, [{}], true),
);
