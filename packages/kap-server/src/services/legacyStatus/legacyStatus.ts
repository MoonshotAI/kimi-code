import {
  agentContextOf,
  ErrorCodes,
  IAgentLoopService,
  ISessionTokenCountingService,
  ISessionUsageService,
  IModelCatalog,
  IModelService,
  ProfileErrors,
  isError2,
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
    if (!isMissingConfiguredModel(error, model)) throw error;
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

export function isMissingConfiguredModel(error: unknown, model: string): boolean {
  return isError2(error) &&
    (error.code === ErrorCodes.CONFIG_INVALID || error.code === ProfileErrors.codes.MODEL_CONFIG_INVALID) &&
    error.details?.['model'] === model &&
    error.message === `Model "${model}" is not configured in config.toml.`;
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
