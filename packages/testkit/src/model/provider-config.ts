import type { KimiConfig } from '#/fixtures/config';
import type { FakeModel } from '#/model/fake-model';

export type FakeProviderType = 'kimi' | 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface FakeProviderOptions {
  readonly type?: FakeProviderType;
  readonly alias?: string;
  readonly providerAlias?: string;
  readonly modelName?: string;
  readonly maxContextSize?: number;
  readonly capabilities?: readonly string[];
  readonly apiKey?: string;
}

export const FAKE_PROVIDER_DEFAULTS = {
  type: 'kimi',
  alias: 'testkit',
  modelName: 'testkit-model',
  maxContextSize: 262_144,
  apiKey: 'sk-testkit',
} as const;

export function fakeModelConfig(model: FakeModel, options: FakeProviderOptions = {}): KimiConfig {
  const type = options.type ?? FAKE_PROVIDER_DEFAULTS.type;
  const alias = options.alias ?? FAKE_PROVIDER_DEFAULTS.alias;
  const providerAlias = options.providerAlias ?? alias;
  return {
    defaultModel: alias,
    providers: {
      [providerAlias]: {
        type,
        baseUrl: type === 'google-genai' ? model.origin : model.baseUrl,
        apiKey: options.apiKey ?? FAKE_PROVIDER_DEFAULTS.apiKey,
      },
    },
    models: {
      [alias]: {
        provider: providerAlias,
        model: options.modelName ?? FAKE_PROVIDER_DEFAULTS.modelName,
        maxContextSize: options.maxContextSize ?? FAKE_PROVIDER_DEFAULTS.maxContextSize,
        capabilities: options.capabilities,
      },
    },
  };
}
