import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { ErrorCodes, Error2 } from '#/errors';
import type { AssistantMessage } from '#human/llm/message';
import type { TokenUsage } from '#human/llm-requester/usage';

import { IProtocolAdapterRegistry } from '../protocol/protocol';

import { IModelCatalog, type Model } from './catalog';
import { runWithCredentialRecovery } from './credential-recovery';
import { generateModel, type ModelRequestParams } from './generate';
import { IModelRequester, type ModelRequest, type ModelResponse } from './model-requester';
import {
  drivesThinkingThroughTraits,
  requiresStrictThinkingValidation,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  type ThinkingConfig,
} from './thinking';

export class ModelRequester implements IModelRequester {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocols: IProtocolAdapterRegistry,
    @IConfigService private readonly config: IConfigService,
  ) {}

  request(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const model = this.catalog.get(request.modelAlias);
    const params: ModelRequestParams = {
      cacheKey: request.cacheKey,
      sampling: request.sampling,
      thinkingEffort: this.thinkingEffort(model),
    };
    return runWithCredentialRecovery(
      model.credentialProvider,
      () => this.generate(model, params, request, signal),
      signal,
    );
  }

  private thinkingEffort(model: Model): ModelRequestParams['thinkingEffort'] {
    const config = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const effort = resolveThinkingEffortForModel(
      undefined,
      config,
      model,
      requiresStrictThinkingValidation(this.protocols, model.protocol, model.providerType),
    );
    return (
      resolveForcedThinkingEffort(
        config?.forcedEffort,
        effort,
        drivesThinkingThroughTraits(model.providerType),
      ) ?? effort
    );
  }

  private async generate(
    model: Model,
    params: ModelRequestParams,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    let message: AssistantMessage | undefined;
    let usage: TokenUsage | undefined;
    let requestId: string | undefined;
    for await (const event of generateModel(
      this.protocols.request(model, params),
      {
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        responseFormat: request.responseFormat,
      },
      signal,
      params,
      { recoveries: [], retry: { maxAttemptsPerStep: request.maxAttempts ?? 1 } },
    )) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'finish') {
        message = event.message;
        requestId = event.requestId;
      }
    }
    if (message === undefined) {
      throw new Error2(ErrorCodes.PROVIDER_API_ERROR, 'LLM request stream ended without a finish event.');
    }
    return { message, usage, requestId };
  }
}

registerScopedService(
  LifecycleScope.App,
  IModelRequester,
  ModelRequester,
  ScopeActivation.OnDemand,
  'modelRequester',
);
