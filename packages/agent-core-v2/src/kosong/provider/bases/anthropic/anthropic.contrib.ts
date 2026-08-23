import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import { AnthropicChatProvider, getAnthropicModelCapability } from './anthropic';
import { composeAnthropicHooks } from './anthropicHooks';
import { compactObject, firstProcessEnv, traitEndpoint, traitProvides } from '../openai/openaiHooks';

registerProtocolBase({
  id: 'anthropic',
  capability: getAnthropicModelCapability,
  createChatProvider({ config, traits }) {
    const endpoint = traitEndpoint(traits);
    return new AnthropicChatProvider({
      ...(traitProvides(traits) as Partial<ConstructorParameters<typeof AnthropicChatProvider>[0]>),
      model: config.modelName,
      ...compactObject({
        apiKey: config.apiKey ?? firstProcessEnv(endpoint?.apiKeyEnv),
        baseUrl:
          config.baseUrl ?? firstProcessEnv(endpoint?.baseUrlEnv) ?? endpoint?.defaultBaseUrl,
        defaultHeaders: traitDefaultHeaders(traits),
        defaultMaxTokens: config.providerOptions?.defaultMaxTokens,
        adaptiveThinking: config.providerOptions?.adaptiveThinking,
        supportEfforts: config.providerOptions?.supportEfforts,
        betaApi: config.providerOptions?.betaApi,
        metadata:
          config.providerOptions?.metadata === undefined
            ? undefined
            : { ...config.providerOptions.metadata },
        hooks: composeAnthropicHooks(traits),
      }),
    });
  },
});
