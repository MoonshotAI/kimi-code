import type { KimiConfigFacade } from '@moonshot-ai/kimi-code-sdk';

export function providerSection(config: KimiConfigFacade): Record<string, unknown> {
  return { ...config.get<Record<string, unknown>>('providers') };
}

export function modelSection(config: KimiConfigFacade): Record<string, unknown> {
  return { ...config.get<Record<string, unknown>>('models') };
}

export async function removeProviderFromConfig(
  config: KimiConfigFacade,
  providerId: string,
): Promise<void> {
  const providers = providerSection(config);
  const models = modelSection(config);
  delete providers[providerId];
  for (const key of Object.keys(models)) {
    if (key.startsWith(`${providerId}/`)) delete models[key];
  }
  const defaultModel = config.get<string | undefined>('defaultModel');
  await config.replace({
    providers,
    models,
    defaultModel:
      defaultModel !== undefined && defaultModel.startsWith(`${providerId}/`)
        ? undefined
        : defaultModel,
  });
}
