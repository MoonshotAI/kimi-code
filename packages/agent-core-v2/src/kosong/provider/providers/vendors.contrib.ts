/**
 * `kosong/provider` domain (L2) — side-effect module: endpoint-only provider
 * definitions for the OpenAI-compatible vendors added for Kimi-free usage
 * (DeepSeek / Qwen / Zhipu / Baichuan / MiniMax / Ollama / generic custom).
 *
 * Each of these speaks the OpenAI wire protocol (or, for Ollama, its
 * OpenAI-compatible endpoint), so every definition composes with
 * `baseProtocol: 'openai'` and carries no vendor traits — adapter identity,
 * capability resolution, and model discovery behave exactly as an
 * unregistered `openai` vendor does, while the id (`deepseek`, `qwen`, …)
 * keeps the provider type meaningful in config and UI. `baseId` in
 * `resolveAdapterIdentity` is always the protocol (`openai`), so this is
 * purely a registry entry for endpoint/env resolution and `providerWireType`
 * validation upstream.
 *
 * `custom` gets no `apiKeyEnv`: its key and URL come entirely from the
 * provider form (the user picks the endpoint), so there is no env fallback.
 *
 * Like every contrib, this module is imported for effect only — production
 * gets it from the `src/index.ts` side-effect block.
 */

import { registerProviderDefinition } from '../providerDefinition';

registerProviderDefinition({
  id: 'deepseek',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL' },
});

registerProviderDefinition({
  id: 'qwen',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'DASHSCOPE_API_KEY', baseUrlEnv: 'DASHSCOPE_BASE_URL' },
});

registerProviderDefinition({
  id: 'zhipu',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'ZHIPU_API_KEY', baseUrlEnv: 'ZHIPU_BASE_URL' },
});

registerProviderDefinition({
  id: 'baichuan',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'BAICHUAN_API_KEY', baseUrlEnv: 'BAICHUAN_BASE_URL' },
});

registerProviderDefinition({
  id: 'minimax',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'MINIMAX_API_KEY', baseUrlEnv: 'MINIMAX_BASE_URL' },
});

registerProviderDefinition({
  id: 'ollama',
  baseProtocol: 'openai',
  traits: [],
});

registerProviderDefinition({
  id: 'custom',
  baseProtocol: 'openai',
  traits: [],
});
