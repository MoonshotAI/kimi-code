import type { LlmRequestModel } from '@moonshot-ai/core/llm/request';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmRequesterExecution } from '@moonshot-ai/core/llm/policy/policy';
import type { IConfigService } from '#/app/config/config';
import type { IAgentProfileService, ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';
import { resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { getProviderDefinition } from '#/llm-adapter/provider/provider-definition';
import type { ProviderRequesterFactory } from '#/provider-catalog/requester';
import type {
  CoreLoopRequesterOptions,
  RequestConfigSnapshot,
  RequesterBinding,
} from './requesterContract';

export interface AgentRequesterBinderOptions {
  readonly config: IConfigService;
  readonly profile: IAgentProfileService;
  readonly modelCatalog: IModelCatalog;
  readonly requesterFactory: Pick<ProviderRequesterFactory, 'request'>;
  readonly requesterExecution: LlmRequesterExecution;
}

export class AgentRequesterBinder {
  constructor(private readonly options: AgentRequesterBinderOptions) {}

  requestConfigSnapshot(profile: ProfileBindingSnapshot): RequestConfigSnapshot {
    return {
      resolved: this.options.profile.resolveModelContext(profile),
      params: this.options.profile.resolveRequestParams(profile),
      systemPrompt: this.options.profile.getSystemPrompt(profile),
      maxCompletionTokensCap: this.options.config.get<ModelOverrides>(
        'modelOverrides',
      )?.maxCompletionTokens,
    };
  }

  bindRequester(
    options: Pick<CoreLoopRequesterOptions, 'maxOutputSize'>,
    config: RequestConfigSnapshot,
  ): RequesterBinding {
    const resolved = config.resolved;
    const model = this.options.modelCatalog.get(resolved.modelAlias);
    const budget = resolveCompletionBudget({
      maxOutputSize: options.maxOutputSize ?? resolved.maxOutputSize,
      maxCompletionTokensCap: config.maxCompletionTokensCap,
    });
    const maxCompletionTokensCap = config.maxCompletionTokensCap;
    const optedOut = maxCompletionTokensCap !== undefined && maxCompletionTokensCap <= 0;
    const maxOutputTokens: LlmRequestModel['maxOutputTokens'] = optedOut
      ? 'none'
      : budget === undefined
        ? undefined
        : Math.max(1, budget);
    const params: InitializedLlmRequestPart = {
      ...config.params,
      model: {
        ...config.params.model,
        spec: {
          ...model.spec,
          maxContextSize: resolved.model.maxContextSize,
          maxInputSize: resolved.model.maxInputSize,
        },
        maxOutputTokens,
      },
    };
    const provider = model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
    return {
      request: this.options.requesterFactory.request(
        model,
        params,
        this.options.requesterExecution,
      ),
      model,
      requestMetadata: provider?.requestMetadata === true,
    };
  }
}
