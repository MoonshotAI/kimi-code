import {
  emptyUsage,
  generate,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ProviderRequestAuth,
  type Tool as KosongTool,
} from '@moonshot-ai/kosong';

import type { KimiConfig } from '../../../config';
import { registerSingleton, SyncDescriptor } from '../../../di';
import type { ModelProvider } from '../../../session/provider-manager';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../../utils/completion-budget';
import { IProfileService } from '../profile/profile';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { IToolCatalogService } from '../toolCatalog/toolCatalog';
import type { LLMEvent, LLMRequestOverrides } from '../types';
import { ILLMRequestLogService } from '../llmRequestLog/llmRequestLog';
import { AsyncEventQueue } from './asyncEventQueue';
import { ILLMRequester } from './llmRequester';

export interface LLMRequesterServiceOptions {
  readonly modelProvider?: ModelProvider;
  readonly config?: KimiConfig | (() => KimiConfig);
  readonly generate?: typeof generate;
}

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export class LLMRequesterService implements ILLMRequester {
  constructor(
    private readonly options: LLMRequesterServiceOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @IToolCatalogService private readonly tools: IToolCatalogService,
    @IProfileService private readonly profile: IProfileService,
    @ILLMRequestLogService private readonly requestLog: ILLMRequestLogService,
  ) {
    if (options.modelProvider !== undefined || options.config !== undefined) {
      this.profile.configure({
        modelProvider: options.modelProvider,
        config: options.config,
      });
    }
  }

  request(
    overrides: LLMRequestOverrides = {},
    signal?: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    return this.requestStream(overrides, signal);
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
    const resolved = this.profile.resolveModelContext();
    const providerWithEnv = this.profile.getProvider();
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

  private resolveAuth(modelAlias: string) {
    return this.options.modelProvider?.resolveAuth?.(modelAlias);
  }

  private defaultTools(): readonly KosongTool[] {
    return this.tools
      .list()
      .filter((tool) => tool.active)
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

registerSingleton(ILLMRequester, new SyncDescriptor(LLMRequesterService, [{}], true));
