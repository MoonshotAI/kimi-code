import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import { getGoogleGenAIModelCapability, GoogleGenAIChatProvider } from './google-genai';
import { compactObject, firstProcessEnv, traitEndpoint, traitProvides } from '../openai/openaiHooks';

registerProtocolBase({
  id: 'google-genai',
  capability: getGoogleGenAIModelCapability,
  createChatProvider({ config, traits }) {
    const endpoint = traitEndpoint(traits);
    return new GoogleGenAIChatProvider({
      ...(traitProvides(traits) as Partial<
        ConstructorParameters<typeof GoogleGenAIChatProvider>[0]
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
        vertexai: config.providerOptions?.vertexai,
        project: config.providerOptions?.project,
        location: config.providerOptions?.location,
      }),
    });
  },
});
