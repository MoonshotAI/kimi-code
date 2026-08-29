import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import { getOpenAILegacyModelCapability, OpenAILegacyChatProvider } from './openai-legacy';
import {
  compactObject,
  composeOpenAIChatHooks,
  firstProcessEnv,
  traitEndpoint,
  traitProvides,
} from './openaiHooks';

registerProtocolBase({
  id: 'openai',
  capability: getOpenAILegacyModelCapability,
  createChatProvider({ config, traits }) {
    const endpoint = traitEndpoint(traits);
    return new OpenAILegacyChatProvider({
      ...(traitProvides(traits) as Partial<
        ConstructorParameters<typeof OpenAILegacyChatProvider>[0]
      >),
      model: config.modelName,
      ...compactObject({
        apiKey:
          config.apiKey ??
          firstProcessEnv(endpoint?.apiKeyEnv) ??
          (endpoint === undefined ? undefined : ''),
        baseUrl:
          config.baseUrl ?? firstProcessEnv(endpoint?.baseUrlEnv) ?? endpoint?.defaultBaseUrl,
        defaultHeaders: traitDefaultHeaders(traits),
        maxTokens: config.providerOptions?.defaultMaxTokens,
        reasoningKey: config.providerOptions?.reasoningKey,
        offEffort: config.providerOptions?.offEffort,
        hooks: composeOpenAIChatHooks(traits),
      }),
    });
  },
});
