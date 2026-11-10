import {
  agentContextOf,
  IAgentProfileService,
  ISessionTokenCountingService,
  ISessionUsageService,
  IModelCatalog,
  IModelService,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  readonly maxContextTokens?: number;
  readonly model: string;
}

export function readLegacyStatus(agent: IAgentScopeHandle): LegacyStatusSnapshot | undefined {
  const profile = agent.accessor.get(IAgentProfileService) as
    | IAgentProfileService
    | undefined;
  const usageService = agent.accessor.get(ISessionUsageService) as
    | ISessionUsageService
    | undefined;
  const tokenCounting = agent.accessor.get(ISessionTokenCountingService) as
    | ISessionTokenCountingService
    | undefined;
  if (profile === undefined || usageService === undefined || tokenCounting === undefined) {
    return undefined;
  }
  const context = agentContextOf(agent);
  const usage = usageService.status(context);
  const contextTokens = tokenCounting.statusSize(context);
  const capabilities = profile.getModelCapabilities();
  let maxContextTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  if (maxContextTokens === 0 && profile.getModel() === '') {
    maxContextTokens = defaultModelContextTokens(agent) ?? 0;
  }
  const model = profile.getModel();
  return {
    usage,
    contextTokens,
    maxContextTokens: maxContextTokens > 0 ? maxContextTokens : undefined,
    model,
  };
}

function defaultModelContextTokens(agent: IAgentScopeHandle): number | undefined {
  const models = agent.accessor.get(IModelService) as IModelService | undefined;
  const catalog = agent.accessor.get(IModelCatalog) as IModelCatalog | undefined;
  const defaultModel = models?.getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0 || catalog === undefined) {
    return undefined;
  }
  try {
    const capabilities = catalog.get(defaultModel).capabilities;
    return capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  } catch {
    return undefined;
  }
}
