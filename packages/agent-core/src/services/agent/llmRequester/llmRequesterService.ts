import {
  createProvider,
  emptyUsage,
  generate,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ModelCapability,
  type ProviderConfig,
  type ProviderRequestAuth,
  type Tool as KosongTool,
} from '@moonshot-ai/kosong';

import {
  applyKimiEnvSamplingParams,
  applyKimiEnvThinkingKeep,
} from '../../../config/kimi-env-params';
import type { KimiConfig } from '../../../config';
import { registerSingleton, SyncDescriptor } from '../../../di';
import { ErrorCodes, KimiError } from '../../../errors';
import type { ModelProvider } from '../../../session/provider-manager';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../../utils/completion-budget';
import { resolveThinkingEffort } from '../../../agent/config/thinking';
import { IProfileService } from '../profile/profile';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { LLMEvent, LLMRequestOverrides } from '../types';
import { ILLMRequestLogService } from '../llmRequestLog/llmRequestLog';
import { AsyncEventQueue } from './asyncEventQueue';
import { ILLMRequester, type LLMModelContext } from './llmRequester';

export interface LLMRequesterServiceOptions {
  readonly modelProvider?: ModelProvider;
  readonly config?: KimiConfig | (() => KimiConfig);
  readonly generate?: typeof generate;
}

const EMPTY_CONFIG: KimiConfig = { providers: {} };
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export class LLMRequesterService implements ILLMRequester {
  constructor(
    private readonly options: LLMRequesterServiceOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @IToolRegistry private readonly tools: IToolRegistry,
    @IProfileService private readonly profile: IProfileService,
    @ILLMRequestLogService private readonly requestLog: ILLMRequestLogService,
  ) {}

  request(
    overrides: LLMRequestOverrides = {},
    signal?: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    return this.requestStream(overrides, signal);
  }

  getModelContext(): LLMModelContext {
    const resolved = this.resolveModelContext();
    return {
      modelAlias: resolved.modelAlias,
      modelCapabilities: resolved.modelCapabilities,
      reservedContextSize: resolved.reservedContextSize,
      compactionTriggerRatio: resolved.compactionTriggerRatio,
    };
  }

  private async *requestStream(
    overrides: LLMRequestOverrides,
    signal: AbortSignal | undefined,
  ): AsyncIterable<LLMEvent> {
    signal?.throwIfAborted();
    const request = this.resolveRequest(overrides);
    const queue = new AsyncEventQueue<LLMEvent>();
    void this.runRequest(request, signal, queue).then(
      () => queue.end(),
      (error: unknown) => queue.fail(error),
    );
    yield* queue;
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<LLMEvent>,
  ): Promise<void> {
    let requestStartedAt = Date.now();
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    const callbacks: GenerateCallbacks = {
      onMessagePart: (part) => {
        firstChunkAt ??= Date.now();
        queue.push({ type: 'part', part });
      },
    };
    const run = async (auth: ProviderRequestAuth | undefined): Promise<void> => {
      requestStartedAt = Date.now();
      firstChunkAt = undefined;
      streamEndedAt = undefined;
      this.requestLog.logRequest({
        provider: request.provider,
        modelAlias: request.modelAlias,
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages: request.messages,
        fields: request.requestLogFields,
      });
      const result = await request.generate(
        request.provider,
        request.systemPrompt,
        [...request.tools],
        request.messages,
        callbacks,
        {
          signal,
          auth,
          onRequestStart: () => {
            requestStartedAt = Date.now();
          },
          onStreamEnd: () => {
            streamEndedAt = Date.now();
          },
        },
      );
      queue.push({
        type: 'usage',
        usage: result.usage ?? emptyUsage(),
        model: request.modelAlias ?? request.provider.modelName,
      });
      queue.push({
        type: 'finish',
        providerFinishReason: result.finishReason ?? undefined,
        rawFinishReason: result.rawFinishReason ?? undefined,
      });
      if (firstChunkAt !== undefined) {
        const outputEndedAt = streamEndedAt ?? Date.now();
        queue.push({
          type: 'timing',
          firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
          streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
        });
      }
    };
    const withAuth = this.resolveAuth(request.modelAlias);
    if (withAuth === undefined) {
      await run(undefined);
      return;
    }
    await withAuth((auth) => run(auth));
  }

  private resolveRequest(overrides: LLMRequestOverrides): ResolvedLLMRequest {
    const resolved = this.resolveModelContext();
    const thinkingLevel = this.resolveThinkingLevel(resolved.thinkingLevel, resolved);
    const baseProvider = createProvider(resolved.provider).withThinking(thinkingLevel);
    const providerWithEnv = applyKimiEnvThinkingKeep(
      applyKimiEnvSamplingParams(baseProvider),
      thinkingLevel,
    );
    const provider = applyCompletionBudget({
      provider: providerWithEnv,
      budget: resolveCompletionBudget({
        maxOutputSize: resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
      }),
      capability: resolved.modelCapabilities,
    });

    return {
      provider,
      modelAlias: resolved.modelAlias,
      systemPrompt: overrides.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...(overrides.messages ?? this.projector.project(this.context.getHistory()))],
      requestLogFields: overrides.requestLogFields,
      generate: this.options.generate ?? generate,
    };
  }

  private resolveModelContext(): ResolvedLLMModelContext {
    const modelProvider = this.options.modelProvider;
    if (modelProvider === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model provider not set');
    }

    const data = this.profile.data();
    const modelAlias = data.modelAlias ?? modelProvider.defaultModel;
    if (modelAlias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }

    const config = this.config();
    const resolved = modelProvider.resolveProviderConfig(modelAlias);
    return {
      provider: resolved.provider,
      modelAlias,
      modelCapabilities: resolved.modelCapabilities,
      maxOutputSize: resolved.maxOutputSize,
      alwaysThinking: resolved.alwaysThinking,
      thinkingLevel: data.thinkingLevel,
      reservedContextSize: config.loopControl?.reservedContextSize,
      compactionTriggerRatio: config.loopControl?.compactionTriggerRatio,
    };
  }

  private resolveThinkingLevel(
    requested: string | undefined,
    resolved: { readonly alwaysThinking?: boolean; readonly modelCapabilities: ModelCapability },
  ) {
    const config = this.config();
    const thinking = resolveThinkingEffort(requested, config.thinking);
    if (thinking === 'off' && resolved.alwaysThinking === true) {
      return resolveThinkingEffort('on', config.thinking);
    }
    return thinking;
  }

  private resolveAuth(modelAlias: string) {
    return this.options.modelProvider?.resolveAuth?.(modelAlias);
  }

  private config(): KimiConfig {
    const config = this.options.config;
    if (config === undefined) return EMPTY_CONFIG;
    return typeof config === 'function' ? config() : config;
  }

  private defaultTools(): readonly KosongTool[] {
    return this.tools
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      }));
  }
}

interface ResolvedLLMRequest {
  readonly provider: ChatProvider;
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly tools: readonly KosongTool[];
  readonly messages: Message[];
  readonly requestLogFields: LLMRequestOverrides['requestLogFields'];
  readonly generate: typeof generate;
}

interface ResolvedLLMModelContext extends LLMModelContext {
  readonly provider: ProviderConfig;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: string | undefined;
}

registerSingleton(ILLMRequester, new SyncDescriptor(LLMRequesterService, [{}], true));
