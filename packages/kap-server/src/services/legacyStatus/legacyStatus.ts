import {
  agentContextOf,
  IAgentLoopService,
  ISessionTokenCountingService,
  ISessionUsageService,
  IModelCatalog,
  IModelService,
  isMissingConfiguredModelError,
  MAIN_AGENT_ID,
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
  const profile = agent.accessor.get(IAgentLoopService) as
    | IAgentLoopService
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
  const model = profile.getModel();
  let modelSpec;
  try {
    modelSpec = model === '' ? undefined : profile.resolveModelContext().model;
  } catch (error) {
    if (context.agentId !== MAIN_AGENT_ID || !isMissingConfiguredModelError(error, model)) throw error;
  }
  let maxContextTokens = modelSpec?.maxInputSize ?? modelSpec?.maxContextSize ?? 0;
  if (maxContextTokens === 0) {
    maxContextTokens = defaultModelContextTokens(agent) ?? 0;
  }
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
    const model = catalog.get(defaultModel);
    return model.spec.maxInputSize ?? model.spec.maxContextSize;
  } catch {
    return undefined;
  }
}
