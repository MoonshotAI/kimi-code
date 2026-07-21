/**
 * `kosong/provider` domain (L2) — side-effect module: registers the OpenAI
 * Chat Completions base (`id: 'openai'`).
 *
 * The factory is the base side's only contact with the registry world: it
 * aggregates the construction-time trait declarations (endpoint, headers,
 * `provides`), composes the hook set, and bakes both into the base's options.
 *
 * Load-bearing detail: when a trait declared an endpoint but neither config
 * nor the env chain produced an apiKey, the factory passes `''` — NOT
 * `undefined` — so the base constructor's own `OPENAI_API_KEY` environment
 * fallback is suppressed. Composing a vendor over this transport can never
 * silently pick up an unrelated OpenAI key.
 */

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
          // `''` suppresses the base's own OPENAI_API_KEY env fallback once a
          // trait took over the endpoint declaration; `undefined` (no endpoint
          // declared) keeps the base default.
          (endpoint === undefined ? undefined : ''),
        baseUrl:
          config.baseUrl ?? firstProcessEnv(endpoint?.baseUrlEnv) ?? endpoint?.defaultBaseUrl,
        defaultHeaders: traitDefaultHeaders(traits),
        maxTokens: config.providerOptions?.defaultMaxTokens,
        reasoningKey: config.providerOptions?.reasoningKey,
        hooks: composeOpenAIChatHooks(traits),
      }),
    });
  },
});
