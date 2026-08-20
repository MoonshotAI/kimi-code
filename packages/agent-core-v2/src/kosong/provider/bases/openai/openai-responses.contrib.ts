import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitConvertError, traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import { getOpenAIResponsesModelCapability, OpenAIResponsesChatProvider } from './openai-responses';
import { compactObject, firstProcessEnv, traitEndpoint, traitProvides } from './openaiHooks';

registerProtocolBase({
  id: 'openai_responses',
  capability: getOpenAIResponsesModelCapability,
  createChatProvider({ config, traits }) {
    const endpoint = traitEndpoint(traits);
    return new OpenAIResponsesChatProvider({
      ...(traitProvides(traits) as Partial<
        ConstructorParameters<typeof OpenAIResponsesChatProvider>[0]
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
        maxOutputTokens: config.providerOptions?.defaultMaxTokens,
        offEffort: config.providerOptions?.offEffort,
        convertError: traitConvertError(traits),
      }),
    });
  },
});
