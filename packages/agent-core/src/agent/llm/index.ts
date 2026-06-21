import { generate } from '@moonshot-ai/kosong';
import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';
import type { KimiConfig } from '#/rpc';

import type { ModelProvider } from '../../session/provider-manager';
import { resolveCompletionBudget } from '../../utils/completion-budget';
import { LlmRequestLogger, splitGenerateOptions } from '../llm-request-logger';
import { KosongLLM } from '../turn/kosong-llm';

/**
 * Narrow view of the agent config service that {@link LlmService} needs to
 * build requests and the {@link KosongLLM}. Kept minimal (rather than taking
 * the whole `IAgentConfigService`) so the service is easy to construct in
 * tests and stays decoupled from config's wider surface. `IAgentConfigService`
 * satisfies this structurally.
 */
export interface LlmServiceConfig {
  readonly modelAlias: string | undefined;
  readonly provider: ChatProvider;
  readonly maxOutputSize: number | undefined;
  readonly systemPrompt: string;
  readonly modelCapabilities: ModelCapability;
}

/**
 * Explicit dependencies for {@link LlmService}. Captures everything the
 * `generate`/`llm` getters read from `Agent` so the bodies can move here
 * byte-for-byte without reaching back into the agent instance.
 */
export interface LlmServiceDeps {
  readonly config: LlmServiceConfig;
  readonly llmRequestLogger: LlmRequestLogger;
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider | undefined;
  readonly log: Logger;
  readonly kimiConfig?: KimiConfig | undefined;
}

export interface ILlmService {
  readonly generate: typeof generate;
  readonly llm: KosongLLM;
}

/**
 * Owns the `generate` getter (request-log injection + request-scoped auth
 * resolution) and the `llm` getter (`KosongLLM` construction). `Agent`
 * delegates to an instance of this; behavior is byte-identical to the former
 * inline getters.
 */
export class LlmService implements ILlmService {
  constructor(private readonly deps: LlmServiceDeps) {}

  get generate(): typeof generate {
    const { config, llmRequestLogger, rawGenerate, modelProvider, log } = this.deps;
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      const { requestLogFields, generateOptions } = splitGenerateOptions(options);
      const modelAlias = config.modelAlias;
      const run = (requestOptions: Parameters<typeof generate>[5]) => {
        llmRequestLogger.logRequest({
          provider,
          modelAlias,
          systemPrompt,
          tools,
          messages: history,
          fields: requestLogFields,
        });
        return rawGenerate(provider, systemPrompt, tools, history, callbacks, requestOptions);
      };
      if (generateOptions?.auth !== undefined) {
        return run(generateOptions);
      }
      const withAuth =
        modelAlias === undefined ? undefined : modelProvider?.resolveAuth?.(modelAlias, { log });
      if (withAuth === undefined) {
        return run(generateOptions);
      }
      return withAuth((auth) => {
        return run({ ...generateOptions, auth });
      });
    };
  }

  get llm(): KosongLLM {
    // All provider-level request config (thinking, sampling params, thinking.keep)
    // is applied in ConfigState.provider so compaction shares it. See get provider().
    const { config, kimiConfig } = this.deps;
    const provider = config.provider;
    const loopControl = kimiConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      maxOutputSize: config.maxOutputSize,
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new KosongLLM({
      provider,
      systemPrompt: config.systemPrompt,
      capability: config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
    });
  }
}
