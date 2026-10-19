import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentLLMRequesterService,
  type AgentLLMTurnRequestSnapshot,
} from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { inputTotal } from '#human/llm/usage';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import { IAgentCacheProbeService } from './cacheProbe';
import { type UsageRecordedContext } from './usage';

export class AgentCacheProbeService extends Service implements IAgentCacheProbeService {
  declare readonly _serviceBrand: undefined;

  private parentId: string | undefined;

  private parentRequest: AgentLLMTurnRequestSnapshot | undefined;

  constructor(
    @ISessionUsageService usage: ISessionUsageService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    if (scopeContext.forkedFrom === undefined) return;
    this.parentId = scopeContext.forkedFrom;
    this.parentRequest = agentLifecycle
      .handleOf(this.parentId)
      ?.accessor.get(IAgentLLMRequesterService)
      .lastTurnRequest();
    this._register(
      usage.onDidRecord((e) => {
        if (e.agent.agentId === scopeContext.agentId) this.probe(e);
      }),
    );
  }

  private probe(e: UsageRecordedContext): void {
    if (!e.firstRecord || e.source?.type !== 'turn') return;
    const parentRevision =
      this.parentId === undefined
        ? undefined
        : this.agentLifecycle
            .handleOf(this.parentId)
            ?.accessor.get(IAgentContextMemoryService)
            .prefixRevision();
    const parent =
      this.parentRequest !== undefined && this.parentRequest.contextRevision === parentRevision
        ? this.parentRequest
        : undefined;
    let providerType: string | undefined;
    let protocol: string | undefined;
    try {
      const model = this.models.get(e.model);
      providerType = model.providerType ?? model.protocol;
      protocol = model.protocol;
    } catch { }
    const own = this.instantiation
      .invokeFunction((accessor) => accessor.get(IAgentLLMRequesterService))
      .lastTurnRequest();
    const sameModel = parent !== undefined && parent.modelAlias === e.model;
    const compared = sameModel && own !== undefined;
    this.telemetry.track2('prompt_cache_probe', {
      source: 'fork',
      turn_id: e.source.turnId,
      provider_type: providerType,
      protocol,
      input_tokens: inputTotal(e.usage),
      input_cache_read: e.usage.inputCacheRead,
      input_cache_creation: e.usage.inputCacheCreation,
      output_tokens: e.usage.output,
      tools_match: compared ? own.toolsHash === parent.toolsHash : undefined,
      system_prompt_match: compared ? own.systemPromptHash === parent.systemPromptHash : undefined,
      parent_input_tokens: sameModel ? parent?.inputTokens : undefined,
      parent_request_gap_ms: compared ? own.startedAt - parent.finishedAt : undefined,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCacheProbeService,
  AgentCacheProbeService,
  ScopeActivation.OnScopeCreated,
  'cacheProbe',
);
