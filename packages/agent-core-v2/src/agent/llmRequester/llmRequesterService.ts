/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Thin shell over the god-object `Model` (App scope). Assembles per-turn
 * `LLMRequestInput` from `profile` (system prompt), `contextMemory` +
 * `contextProjector` (history), and `toolRegistry` (tools), applies the
 * completion-token budget through `.withMaxCompletionTokens`, then drives
 * `model.request(input, signal)`. Emits `LLMEvent`s straight through while
 * intercepting `usage` for `IAgentUsageService` accounting and logging the
 * outbound request through `llmRequestLog`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '#/app/model/completionBudget';
import type { Tool } from '#/app/llmProtocol';
import { IConfigService } from '#/app/config';
import { type KimiModelOverrides } from '#/app/model';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { LLMEvent, LLMRequestOverrides } from './index';
import { IAgentLLMRequestLogService } from '#/agent/llmRequestLog';
import { IAgentUsageService } from '#/agent/usage';
import { IAgentLLMRequesterService } from './llmRequester';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequestLogService private readonly requestLog: IAgentLLMRequestLogService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
  ) {}

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

    const resolvedCtx = this.profile.resolveModelContext();
    let model = this.profile.getProvider();
    model = applyCompletionBudget({
      model,
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolvedCtx.maxOutputSize,
        reservedContextSize: resolvedCtx.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolvedCtx.modelCapabilities,
      usedContextTokens: this.contextSize.getStatus().contextTokens,
    });

    const systemPrompt = overrides.systemPrompt ?? this.profile.getSystemPrompt();
    const tools = [...(overrides.tools ?? this.defaultTools())];
    const messages = [...(overrides.messages ?? this.projector.project(this.context.get()))];

    this.requestLog.logRequest({
      protocol: model.protocol,
      modelName: model.name,
      modelAlias: resolvedCtx.modelAlias,
      thinkingEffort: model.thinkingEffort,
      systemPrompt,
      tools,
      messages,
      fields: overrides.requestLogFields,
    });

    const usageModel = resolvedCtx.modelAlias ?? model.name;
    for await (const event of model.request({ systemPrompt, tools, messages }, signal)) {
      if (event.type === 'usage') {
        this.usage.record(usageModel, event.usage, overrides.usageContext);
        yield { ...event, model: usageModel };
        continue;
      }
      yield event;
    }
  }

  private defaultTools(): readonly Tool[] {
    return this.tools
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name, tool.source))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Delayed,
  'llmRequester',
);
