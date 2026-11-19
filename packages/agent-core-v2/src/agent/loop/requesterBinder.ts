import { isDeepStrictEqual } from 'node:util';

import type { LlmRequestModel } from '@moonshot-ai/core/llm/request';
import { requesterContents, type InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmRequesterExecution } from '@moonshot-ai/core/llm/policy/policy';
import type { FullLoopLlmRequester, Loop } from '@moonshot-ai/core/loop/index';
import { Disposable } from '#/_base/di/lifecycle';
import type { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { IAgentProfileService, ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IProviderCatalogRuntime } from '#/llm-adapter/model/catalog-runtime';
import { resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { getProviderDefinition } from '#/llm-adapter/provider/provider-definition';
import type { ProviderRequesterFactory } from '#/provider-catalog/requester';
import { LOOP_CONTROL_SECTION } from './configSection';
import type {
  RequesterOptions,
  RequestConfigSnapshot,
  RequesterBinding,
} from './requesterContract';

const REQUEST_CONFIG_SECTIONS: ReadonlySet<string> = new Set([
  LOOP_CONTROL_SECTION,
  THINKING_SECTION,
  'modelOverrides',
]);

interface RequesterSnapshot {
  readonly requester: FullLoopLlmRequester;
  readonly config: RequestConfigSnapshot;
  readonly binding: RequesterBinding;
}

interface RequesterAttachment {
  readonly loop: Loop;
  current?: RequesterSnapshot;
  failure?: {
    readonly requester: FullLoopLlmRequester;
    readonly error: unknown;
  };
}

export interface AgentRequesterBinderOptions {
  readonly config: IConfigService;
  readonly profile: IAgentProfileService;
  readonly profileSnapshot: () => ProfileBindingSnapshot;
  readonly modelCatalog: IModelCatalog;
  readonly requesterFactory: Pick<ProviderRequesterFactory, 'request'>;
  readonly requesterExecution: LlmRequesterExecution;
  readonly runtime: IProviderCatalogRuntime;
}

export class AgentRequesterBinder extends Disposable {
  private attachment: RequesterAttachment | undefined;

  constructor(private readonly options: AgentRequesterBinderOptions) {
    super();
    this._register(this.options.config.onDidSectionChange(({ domain }) => {
      if (REQUEST_CONFIG_SECTIONS.has(domain)) this.refresh();
    }));
    this._register(this.options.runtime.onChanged(() => this.refresh()));
  }

  invalidate(): void {
    this.refresh();
  }

  attach(loop: Loop): void {
    this.attachment = { loop };
    this.refresh();
  }

  turnSnapshot(requester: FullLoopLlmRequester): RequesterSnapshot {
    const attachment = this.attachment;
    const current = attachment?.current;
    if (attachment?.failure?.requester === requester) throw attachment.failure.error;
    if (attachment === undefined || current?.requester !== requester) {
      throw new Error('Turn requester is not the current binder snapshot');
    }
    const config = this.requestConfigSnapshot(this.options.profileSnapshot());
    return isDeepStrictEqual(config, current.config)
      ? current
      : this.bindCurrent(attachment, config);
  }

  operationSnapshot(
    requester: FullLoopLlmRequester,
    maxOutputSize: number | undefined,
  ): RequesterSnapshot {
    const snapshot = this.turnSnapshot(requester);
    return {
      ...snapshot,
      binding: {
        ...snapshot.binding,
        request: snapshot.binding.request.with({
          model: { maxOutputTokens: this.maxOutputTokens(maxOutputSize, snapshot.config) },
        }),
      },
    };
  }

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
    options: Pick<RequesterOptions, 'maxOutputSize'>,
    config: RequestConfigSnapshot,
  ): RequesterBinding {
    const resolved = config.resolved;
    const model = this.options.modelCatalog.get(resolved.modelAlias);
    const maxOutputTokens = this.maxOutputTokens(options.maxOutputSize, config);
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

  private maxOutputTokens(
    maxOutputSize: number | undefined,
    config: RequestConfigSnapshot,
  ): LlmRequestModel['maxOutputTokens'] {
    const budget = resolveCompletionBudget({
      maxOutputSize: maxOutputSize ?? config.resolved.maxOutputSize,
      maxCompletionTokensCap: config.maxCompletionTokensCap,
    });
    const cap = config.maxCompletionTokensCap;
    if (cap !== undefined && cap <= 0) return 'none';
    return budget === undefined ? undefined : Math.max(1, budget);
  }

  private bindCurrent(
    attachment: RequesterAttachment,
    config: RequestConfigSnapshot,
  ): RequesterSnapshot {
    const binding = this.bindRequester({}, config);
    const requester = binding.request as FullLoopLlmRequester;
    const current = { requester, config, binding };
    attachment.current = current;
    attachment.failure = undefined;
    attachment.loop.setRequester(requester);
    return current;
  }

  private refresh(): void {
    const attachment = this.attachment;
    if (attachment === undefined) return;
    try {
      const profile = this.options.profileSnapshot();
      const config = this.requestConfigSnapshot(profile);
      this.bindCurrent(attachment, config);
    } catch (error) {
      attachment.current = undefined;
      const requester: FullLoopLlmRequester = {
        [requesterContents]: {},
        with: (() => requester) as FullLoopLlmRequester['with'],
        request: () => {
          throw error;
        },
        generate: async () => {
          throw error;
        },
      };
      attachment.failure = { requester, error };
      attachment.loop.setRequester(requester);
    }
  }
}
