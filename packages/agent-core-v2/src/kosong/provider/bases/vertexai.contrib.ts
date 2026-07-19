/**
 * `kosong/provider` domain (L2) — side-effect module: registers the Vertex AI
 * base (`id: 'vertexai'`).
 *
 * Vertex AI is its own base id that reuses the Google GenAI adapter: the
 * factory forces the SDK's vertex mode options from the adapter config's
 * `providerOptions` (`vertexai` / `project` / `location`).
 */

import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import { getGoogleGenAIModelCapability, GoogleGenAIChatProvider } from './google-genai';
import { compactObject, firstProcessEnv, traitEndpoint, traitProvides } from './openaiHooks';

registerProtocolBase({
  id: 'vertexai',
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
