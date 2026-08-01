/**
 * Provider type presets for the provider management UI. Each entry carries
 * the i18n label key, default base URL, and default model so the add/edit
 * form can auto-fill when the user picks a type.
 */

export interface ProviderTypePreset {
  /** Provider id used in config (matches vendors.contrib.ts registrations). */
  readonly value: string;
  /** i18n key path under `providers.types.*`. */
  readonly label: string;
  /** Default base URL for the provider's OpenAI-compatible endpoint. */
  readonly defaultUrl: string;
  /** Default model name for the provider. */
  readonly defaultModel: string;
}

export const PROVIDER_TYPES: readonly ProviderTypePreset[] = [
  {
    value: 'deepseek',
    label: 'providers.types.deepseek',
    defaultUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    value: 'qwen',
    label: 'providers.types.qwen',
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    value: 'moonshot',
    label: 'providers.types.moonshot',
    defaultUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2',
  },
  {
    value: 'kimi',
    label: 'providers.types.kimi',
    defaultUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2',
  },
  {
    value: 'zhipu',
    label: 'providers.types.zhipu',
    defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
  },
  {
    value: 'baichuan',
    label: 'providers.types.baichuan',
    defaultUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
  },
  {
    value: 'minimax',
    label: 'providers.types.minimax',
    defaultUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
  },
  {
    value: 'ollama',
    label: 'providers.types.ollama',
    defaultUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
  },
  {
    value: 'custom',
    label: 'providers.types.custom',
    defaultUrl: '',
    defaultModel: '',
  },
];
